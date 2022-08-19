import { google, oauth2_v2 as oauthV2 } from 'googleapis'
import url from 'url'
import { env, homePageURL } from '../../env'
import { OAuth2Client } from 'googleapis-common'
import { DecodeTokenResult } from './auth_types'
import { LoginErrorCode } from '../../generated/graphql'
import UserModel from '../../datalayer/user'
import { createWebAuthToken, createPendingUserToken } from './jwt_helpers'
import { ssoRedirectURL, createSsoToken } from '../../utils/sso'

export const googleAuthMobile = (): OAuth2Client =>
  new google.auth.OAuth2(env.google.auth.clientId, env.google.auth.secret)

export const googleAuth = (redirectUrl?: string): OAuth2Client =>
  new google.auth.OAuth2(
    env.google.auth.clientId,
    env.google.auth.secret,
    url.resolve(env.server.gateway_url, redirectUrl || '')
  )

const defaultScopes = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

export const generateGoogleLoginURL = (
  auth: typeof google.auth.OAuth2.prototype,
  redirectUrl: string,
  state: string
): string => {
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: defaultScopes,
    state: state,
    redirect_uri: url.resolve(env.server.gateway_url, redirectUrl),
  })
}

export const validateGoogleUser = async (
  authCode: string,
  registerAction?: boolean | null,
  isMobile?: boolean | null
): Promise<oauthV2.Schema$Userinfo | undefined> => {
  try {
    const auth = isMobile
      ? googleAuthMobile()
      : googleAuth('/api/auth/google-login/login')
    const { tokens } = await auth.getToken(authCode)
    auth.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth })
    const result = await oauth2.userinfo.get()

    return result.data
  } catch (e) {
    return undefined
  }
}

const googleWebClient = new OAuth2Client(env.google.auth.clientId)

export async function decodeGoogleToken(
  idToken: string,
  isAndroid: boolean
): Promise<DecodeTokenResult> {
  try {
    const clientID = isAndroid
      ? env.google.auth.androidClientId
      : env.google.auth.iosClientId

    const googleMobileClient = new OAuth2Client(clientID)

    const loginTicket = await googleMobileClient.verifyIdToken({
      idToken,
      audience: clientID,
    })

    const email = loginTicket.getPayload()?.email
    const sourceUserId = loginTicket.getUserId() || undefined
    return { email, sourceUserId }
  } catch (e) {
    console.log('decodeGoogleToken error', e)
    return { errorCode: 500 }
  }
}

type GoogleWebAuthResponse = {
  redirectURL: string
  authToken?: string
  pendingUserAuth?: string
}

export async function handleGoogleWebAuth(
  idToken: string,
  isLocal = false,
  isVercel = false
): Promise<GoogleWebAuthResponse> {
  const baseURL = () => {
    if (isLocal) {
      return 'http://localhost:3000'
    }

    if (isVercel) {
      return homePageURL()
    }

    return env.client.url
  }

  const authFailedRedirect = `${baseURL()}/login?errorCodes=${
    LoginErrorCode.AuthFailed
  }`

  try {
    const loginTicket = await googleWebClient.verifyIdToken({
      idToken,
      audience: env.google.auth.clientId,
    })

    const email = loginTicket.getPayload()?.email
    const sourceUserId = loginTicket.getUserId() || undefined

    if (!email) {
      return Promise.resolve({
        redirectURL: authFailedRedirect,
      })
    }
    const model = new UserModel()
    const user = await model.getWhere({
      email,
      source: 'GOOGLE',
    })
    const userId = user?.id

    if (!userId || !user?.profile) {
      console.log(
        'user or profile does not exist:',
        sourceUserId,
        'GOOGLE',
        email
      )
      // User doesn't exist yet, so we return a pending user token
      // if user's profile doesn't exist, also send back to the profile creation
      const pendingUserAuth = await createPendingUserToken({
        email,
        sourceUserId: sourceUserId ?? '',
        provider: 'GOOGLE',
        name: '',
        username: '',
      })

      return {
        redirectURL: `${baseURL()}/confirm-profile`,
        pendingUserAuth,
      }
    }

    const authToken = await createWebAuthToken(userId)
    if (authToken) {
      const ssoToken = createSsoToken(authToken, `${baseURL()}/home`)
      const redirectURL = isVercel
        ? ssoRedirectURL(ssoToken)
        : `${baseURL()}/home`

      return {
        authToken,
        redirectURL,
      }
    } else {
      return { redirectURL: authFailedRedirect }
    }
  } catch (e) {
    console.log('handleGoogleWebAuth error', e)
    return { redirectURL: authFailedRedirect }
  }
}
