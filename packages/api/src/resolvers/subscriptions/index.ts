import axios from 'axios'
import { parseHTML } from 'linkedom'
import { Brackets } from 'typeorm'
import { Subscription } from '../../entity/subscription'
import { env } from '../../env'
import {
  FeedEdge,
  FeedsError,
  FeedsErrorCode,
  FeedsSuccess,
  MutationSubscribeArgs,
  MutationUnsubscribeArgs,
  MutationUpdateSubscriptionArgs,
  QueryFeedsArgs,
  QueryScanFeedsArgs,
  QuerySubscriptionsArgs,
  ScanFeedsError,
  ScanFeedsErrorCode,
  ScanFeedsSuccess,
  SortBy,
  SortOrder,
  SubscribeError,
  SubscribeErrorCode,
  SubscribeSuccess,
  SubscriptionsError,
  SubscriptionsErrorCode,
  SubscriptionsSuccess,
  SubscriptionStatus,
  SubscriptionType,
  UnsubscribeError,
  UnsubscribeErrorCode,
  UnsubscribeSuccess,
  UpdateSubscriptionError,
  UpdateSubscriptionErrorCode,
  UpdateSubscriptionSuccess,
} from '../../generated/graphql'
import { getRepository } from '../../repository'
import { feedRepository } from '../../repository/feed'
import { unsubscribe } from '../../services/subscriptions'
import { Merge } from '../../util'
import { analytics } from '../../utils/analytics'
import { enqueueRssFeedFetch } from '../../utils/createTask'
import { authorized } from '../../utils/helpers'
import { parseFeed, parseOpml, RSS_PARSER_CONFIG } from '../../utils/parser'

type PartialSubscription = Omit<Subscription, 'newsletterEmail'>

export type SubscriptionsSuccessPartial = Merge<
  SubscriptionsSuccess,
  { subscriptions: PartialSubscription[] }
>
export const subscriptionsResolver = authorized<
  SubscriptionsSuccessPartial,
  SubscriptionsError,
  QuerySubscriptionsArgs
>(async (_obj, { sort, type }, { uid, log }) => {
  try {
    const sortBy =
      sort?.by === SortBy.UpdatedTime ? 'lastFetchedAt' : 'createdAt'
    const sortOrder = sort?.order === SortOrder.Ascending ? 'ASC' : 'DESC'

    const queryBuilder = getRepository(Subscription)
      .createQueryBuilder('subscription')
      .leftJoinAndSelect('subscription.newsletterEmail', 'newsletterEmail')
      .where({
        user: { id: uid },
      })

    if (type && type == SubscriptionType.Newsletter) {
      queryBuilder.andWhere({
        type,
        status: SubscriptionStatus.Active,
      })
    } else if (type && type == SubscriptionType.Rss) {
      queryBuilder.andWhere({
        type,
      })
    } else {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where({
            type: SubscriptionType.Newsletter,
            status: SubscriptionStatus.Active,
          }).orWhere({
            type: SubscriptionType.Rss,
          })
        })
      )
    }

    const subscriptions = await queryBuilder
      .orderBy('subscription.status', 'ASC')
      .addOrderBy(`subscription.${sortBy}`, sortOrder, 'NULLS LAST')
      .getMany()

    return {
      subscriptions,
    }
  } catch (error) {
    log.error(error)
    return {
      errorCodes: [SubscriptionsErrorCode.BadRequest],
    }
  }
})

export type UnsubscribeSuccessPartial = Merge<
  UnsubscribeSuccess,
  { subscription: PartialSubscription }
>
export const unsubscribeResolver = authorized<
  UnsubscribeSuccessPartial,
  UnsubscribeError,
  MutationUnsubscribeArgs
>(async (_, { name, subscriptionId }, { uid, log }) => {
  log.info('unsubscribeResolver')

  try {
    const queryBuilder = getRepository(Subscription)
      .createQueryBuilder('subscription')
      .leftJoinAndSelect('subscription.newsletterEmail', 'newsletterEmail')
      .where({ user: { id: uid } })

    if (subscriptionId) {
      // if subscriptionId is provided, ignore name
      queryBuilder.andWhere({ id: subscriptionId })
    } else {
      // if subscriptionId is not provided, use name for old clients
      queryBuilder.andWhere({ name })
    }

    const subscription = await queryBuilder.getOne()

    if (!subscription) {
      return {
        errorCodes: [UnsubscribeErrorCode.NotFound],
      }
    }

    if (
      subscription.type === SubscriptionType.Newsletter &&
      !subscription.unsubscribeMailTo &&
      !subscription.unsubscribeHttpUrl
    ) {
      log.info('No unsubscribe method found for newsletter subscription')
    }

    await unsubscribe(subscription)

    analytics.track({
      userId: uid,
      event: 'unsubscribed',
      properties: {
        name,
        env: env.server.apiEnv,
      },
    })

    return {
      subscription,
    }
  } catch (error) {
    log.error('failed to unsubscribe', error)
    return {
      errorCodes: [UnsubscribeErrorCode.BadRequest],
    }
  }
})

export type SubscribeSuccessPartial = Merge<
  SubscribeSuccess,
  { subscriptions: PartialSubscription[] }
>
export const subscribeResolver = authorized<
  SubscribeSuccessPartial,
  SubscribeError,
  MutationSubscribeArgs
>(async (_, { input }, { uid, log }) => {
  try {
    analytics.track({
      userId: uid,
      event: 'subscribed',
      properties: {
        ...input,
        env: env.server.apiEnv,
      },
    })

    // find existing subscription
    const existingSubscription = await getRepository(Subscription).findOneBy({
      url: input.url,
      user: { id: uid },
      type: SubscriptionType.Rss,
    })
    if (existingSubscription) {
      if (existingSubscription.status === SubscriptionStatus.Active) {
        return {
          errorCodes: [SubscribeErrorCode.AlreadySubscribed],
        }
      }

      // re-subscribe
      const updatedSubscription = await getRepository(Subscription).save({
        ...existingSubscription,
        status: SubscriptionStatus.Active,
      })

      // create a cloud task to fetch rss feed item for resub subscription
      await enqueueRssFeedFetch({
        userIds: [uid],
        url: input.url,
        subscriptionIds: [updatedSubscription.id],
        scheduledDates: [new Date()], // fetch immediately
        fetchedDates: [updatedSubscription.lastFetchedAt || null],
        checksums: [updatedSubscription.lastFetchedChecksum || null],
        addToLibraryFlags: [!!updatedSubscription.autoAddToLibrary],
      })

      return {
        subscriptions: [updatedSubscription],
      }
    }

    // create new rss subscription
    const MAX_RSS_SUBSCRIPTIONS = 150
    // validate rss feed
    const feed = await parseFeed(input.url)
    if (!feed) {
      return {
        errorCodes: [SubscribeErrorCode.NotFound],
      }
    }

    // limit number of rss subscriptions to 150
    const results = (await getRepository(Subscription).query(
      `insert into omnivore.subscriptions (name, url, description, type, user_id, icon, auto_add_to_library, is_private) 
          select $1, $2, $3, $4, $5, $6, $7, $8 from omnivore.subscriptions 
          where user_id = $5 and type = 'RSS' and status = 'ACTIVE' 
          having count(*) < $9
          returning *;`,
      [
        feed.title,
        feed.url,
        feed.description || null,
        SubscriptionType.Rss,
        uid,
        feed.thumbnail || null,
        input.autoAddToLibrary ?? null,
        input.isPrivate ?? null,
        MAX_RSS_SUBSCRIPTIONS,
      ]
    )) as Subscription[]

    if (results.length === 0) {
      return {
        errorCodes: [SubscribeErrorCode.ExceededMaxSubscriptions],
      }
    }

    const newSubscription = results[0]

    // create a cloud task to fetch rss feed item for the new subscription
    await enqueueRssFeedFetch({
      userIds: [uid],
      url: input.url,
      subscriptionIds: [newSubscription.id],
      scheduledDates: [new Date()], // fetch immediately
      fetchedDates: [null],
      checksums: [null],
      addToLibraryFlags: [!!newSubscription.autoAddToLibrary],
    })

    return {
      subscriptions: [newSubscription],
    }
  } catch (error) {
    log.error('failed to subscribe', error)
    if (error instanceof Error && error.message === 'Status code 404') {
      return {
        errorCodes: [SubscribeErrorCode.NotFound],
      }
    }
    return {
      errorCodes: [SubscribeErrorCode.BadRequest],
    }
  }
})

export type UpdateSubscriptionSuccessPartial = Merge<
  UpdateSubscriptionSuccess,
  { subscription: PartialSubscription }
>
export const updateSubscriptionResolver = authorized<
  UpdateSubscriptionSuccessPartial,
  UpdateSubscriptionError,
  MutationUpdateSubscriptionArgs
>(async (_, { input }, { authTrx, uid, log }) => {
  try {
    analytics.track({
      userId: uid,
      event: 'update_subscription',
      properties: {
        ...input,
        env: env.server.apiEnv,
      },
    })

    const updatedSubscription = await authTrx(async (t) => {
      const repo = t.getRepository(Subscription)

      // update subscription
      await t.getRepository(Subscription).save({
        id: input.id,
        name: input.name || undefined,
        description: input.description || undefined,
        lastFetchedAt: input.lastFetchedAt
          ? new Date(input.lastFetchedAt)
          : undefined,
        lastFetchedChecksum: input.lastFetchedChecksum || undefined,
        status: input.status || undefined,
        scheduledAt: input.scheduledAt
          ? new Date(input.scheduledAt)
          : undefined,
        autoAddToLibrary: input.autoAddToLibrary ?? undefined,
        isPrivate: input.isPrivate ?? undefined,
      })

      return repo.findOneByOrFail({
        id: input.id,
        user: { id: uid },
      })
    })

    return {
      subscription: updatedSubscription,
    }
  } catch (error) {
    log.error('failed to update subscription', error)
    return {
      errorCodes: [UpdateSubscriptionErrorCode.BadRequest],
    }
  }
})

export const feedsResolver = authorized<
  FeedsSuccess,
  FeedsError,
  QueryFeedsArgs
>(async (_, { input }, { log }) => {
  try {
    const startCursor = input.after || ''
    const start =
      startCursor && !isNaN(Number(startCursor)) ? Number(startCursor) : 0
    const first = Math.min(input.first || 10, 100) // cap at 100

    const { feeds, count } = await feedRepository.searchFeeds(
      input.query || '',
      first + 1, // fetch one extra to check if there is a next page
      start,
      input.sort?.by,
      input.sort?.order || undefined
    )

    const hasNextPage = feeds.length > first
    const endCursor = String(start + feeds.length - (hasNextPage ? 1 : 0))

    if (hasNextPage) {
      // remove an extra if exists
      feeds.pop()
    }

    const edges: FeedEdge[] = feeds.map((feed) => ({
      node: feed,
      cursor: endCursor,
    }))

    return {
      __typename: 'FeedsSuccess',
      edges,
      pageInfo: {
        hasPreviousPage: start > 0,
        hasNextPage,
        startCursor,
        endCursor,
        totalCount: count,
      },
    }
  } catch (error) {
    log.error('Error fetching feeds', error)

    return {
      errorCodes: [FeedsErrorCode.BadRequest],
    }
  }
})

export const scanFeedsResolver = authorized<
  ScanFeedsSuccess,
  ScanFeedsError,
  QueryScanFeedsArgs
>(async (_, { input: { opml, url } }, { log, uid }) => {
  analytics.track({
    userId: uid,
    event: 'scan_feeds',
    properties: {
      opml,
      url,
    },
  })

  if (opml) {
    // parse opml
    const feeds = parseOpml(opml)
    if (!feeds) {
      return {
        errorCodes: [ScanFeedsErrorCode.BadRequest],
      }
    }

    return {
      __typename: 'ScanFeedsSuccess',
      feeds: feeds.map((feed) => ({
        url: feed.url,
        title: feed.title,
        type: feed.type || 'rss',
      })),
    }
  }

  if (!url) {
    log.error('Missing opml and url')

    return {
      errorCodes: [ScanFeedsErrorCode.BadRequest],
    }
  }

  try {
    // fetch page content and parse feeds
    const response = await axios.get(url, RSS_PARSER_CONFIG)
    const content = response.data as string
    // check if the content is html or xml
    const contentType = response.headers['content-type']
    const isHtml = contentType?.includes('text/html')
    if (isHtml) {
      // this is an html page, parse rss feed links
      const dom = parseHTML(content).document
      const links = dom.querySelectorAll('link[type="application/rss+xml"]')
      const feeds = Array.from(links)
        .map((link) => ({
          url: link.getAttribute('href') || '',
          title: link.getAttribute('title') || '',
          type: 'rss',
        }))
        .filter((feed) => feed.url)

      return {
        __typename: 'ScanFeedsSuccess',
        feeds,
      }
    }

    // this is the url to an RSS feed
    const feed = await parseFeed(url)
    if (!feed) {
      return {
        errorCodes: [ScanFeedsErrorCode.BadRequest],
      }
    }

    return {
      __typename: 'ScanFeedsSuccess',
      feeds: [feed],
    }
  } catch (error) {
    log.error('Error scanning URL', error)

    return {
      errorCodes: [ScanFeedsErrorCode.BadRequest],
    }
  }
})
