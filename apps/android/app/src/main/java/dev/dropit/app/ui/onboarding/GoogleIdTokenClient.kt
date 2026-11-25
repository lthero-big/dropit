package dev.dropit.app.ui.onboarding

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import kotlinx.coroutines.CancellationException

/**
 * Outcome of invoking Android's native Credential Manager Google account picker.
 */
sealed class GoogleIdTokenFetchResult {
    data class Success(val idToken: String) : GoogleIdTokenFetchResult()
    data object Cancelled : GoogleIdTokenFetchResult()
    data class FallbackToBrowser(val reason: String) : GoogleIdTokenFetchResult()
}

interface GoogleIdTokenFetcher {
    suspend fun fetchIdToken(context: Context, serverClientId: String): GoogleIdTokenFetchResult
}

/**
 * Native Google Sign-In via AndroidX Credential Manager + Google Identity Services.
 * - Uses `setFilterByAuthorizedAccounts(false)` & `setAutoSelectEnabled(false)` so the system
 *   Google bottom account picker is always presented explicitly.
 * - Distinguishes user cancellation ([GetCredentialCancellationException]) from environment /
 *   Play Services / configuration failures so the ViewModel stays silent on cancel and gracefully
 *   falls back to Chrome Custom Tabs on unsupported devices or third-party servers.
 */
object AndroidGoogleIdTokenFetcher : GoogleIdTokenFetcher {
    private const val TAG = "DropitGoogleAuth"

    override suspend fun fetchIdToken(
        context: Context,
        serverClientId: String,
    ): GoogleIdTokenFetchResult {
        val cleanClientId = serverClientId.trim()
        if (cleanClientId.isEmpty()) {
            return GoogleIdTokenFetchResult.FallbackToBrowser("empty_client_id")
        }
        val activity = context.findActivity()
            ?: return GoogleIdTokenFetchResult.FallbackToBrowser("no_activity_context")

        return try {
            val googleIdOption = GetGoogleIdOption.Builder()
                .setServerClientId(cleanClientId)
                .setFilterByAuthorizedAccounts(false)
                .setAutoSelectEnabled(false)
                .build()
            val request = GetCredentialRequest.Builder()
                .addCredentialOption(googleIdOption)
                .build()
            val credentialManager = CredentialManager.create(activity)
            val response = credentialManager.getCredential(
                request = request,
                context = activity,
            )
            val credential = response.credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)
                val idToken = googleCredential.idToken.trim()
                if (idToken.isNotEmpty()) {
                    GoogleIdTokenFetchResult.Success(idToken)
                } else {
                    GoogleIdTokenFetchResult.FallbackToBrowser("empty_id_token")
                }
            } else {
                GoogleIdTokenFetchResult.FallbackToBrowser("unexpected_credential_type")
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (e: Throwable) {
            val classified = classifyCredentialException(e)
            if (classified is GoogleIdTokenFetchResult.FallbackToBrowser) {
                runCatching {
                    Log.i(TAG, "Native Google sign-in unavailable (${classified.reason}), falling back to Custom Tabs")
                }
            }
            classified
        }
    }

    internal fun classifyCredentialException(error: Throwable): GoogleIdTokenFetchResult = when (error) {
        is GetCredentialCancellationException -> GoogleIdTokenFetchResult.Cancelled
        is NoCredentialException -> GoogleIdTokenFetchResult.FallbackToBrowser("no_credential")
        is GetCredentialUnsupportedException -> GoogleIdTokenFetchResult.FallbackToBrowser("unsupported")
        is GetCredentialProviderConfigurationException -> GoogleIdTokenFetchResult.FallbackToBrowser("provider_config")
        is GetCredentialInterruptedException -> GoogleIdTokenFetchResult.FallbackToBrowser("interrupted")
        is GoogleIdTokenParsingException -> GoogleIdTokenFetchResult.FallbackToBrowser("token_parse_error")
        is GetCredentialException -> GoogleIdTokenFetchResult.FallbackToBrowser(error.type.ifBlank { "credential_error" })
        else -> GoogleIdTokenFetchResult.FallbackToBrowser(error::class.java.simpleName)
    }

    private tailrec fun Context.findActivity(): Activity? = when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
}
