package com.neiman.tunestack

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.shazam.shazamkit.AudioSampleRateInHz
import com.shazam.shazamkit.DeveloperToken
import com.shazam.shazamkit.DeveloperTokenProvider
import com.shazam.shazamkit.MatchResult
import com.shazam.shazamkit.ShazamKit
import com.shazam.shazamkit.ShazamKitResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray

@CapacitorPlugin(name = "ShazamIdentifier")
class ShazamIdentifierNativePlugin : Plugin() {
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val configured = BuildConfig.SHAZAM_DEVELOPER_TOKEN.isNotBlank()
        call.resolve(JSObject().apply {
            put("available", configured)
            put("configured", configured)
            put("platform", "android")
            put("sdkVersion", "2.1.1")
            put(
                "message",
                if (configured) {
                    "Native ShazamKit is ready."
                } else {
                    "Add a signed Apple developer token to android/local.properties before building the APK."
                },
            )
        })
    }

    @PluginMethod
    fun identify(call: PluginCall) {
        val token = BuildConfig.SHAZAM_DEVELOPER_TOKEN
        if (token.isBlank()) {
            call.reject("ShazamKit is not configured with an Apple developer token.")
            return
        }

        val encodedPcm = call.getString("pcmBase64")
        if (encodedPcm.isNullOrBlank()) {
            call.reject("A PCM audio sample is required.")
            return
        }

        val sampleRate = call.getInt("sampleRate", 48_000)
        if (sampleRate != 48_000) {
            call.reject("Tunestack currently sends ShazamKit 48 kHz PCM samples only.")
            return
        }

        pluginScope.launch {
            try {
                val pcm = Base64.decode(encodedPcm, Base64.DEFAULT)
                if (pcm.isEmpty() || pcm.size > 1_300_000) {
                    throw IllegalArgumentException("The Shazam audio sample has an invalid size.")
                }

                val generator = when (
                    val generatorResult = ShazamKit.createSignatureGenerator(
                        AudioSampleRateInHz.SAMPLE_RATE_48000,
                    )
                ) {
                    is ShazamKitResult.Success -> generatorResult.data
                    is ShazamKitResult.Failure -> throw generatorResult.reason
                }

                generator.append(pcm, pcm.size, System.currentTimeMillis())
                val signature = generator.generateSignature()
                val provider = DeveloperTokenProvider { DeveloperToken(token) }
                val catalog = ShazamKit.createShazamCatalog(provider)
                val session = when (val sessionResult = ShazamKit.createSession(catalog)) {
                    is ShazamKitResult.Success -> sessionResult.data
                    is ShazamKitResult.Failure -> throw sessionResult.reason
                }

                val response = when (val matchResult = session.match(signature)) {
                    is MatchResult.Match -> {
                        val item = matchResult.matchedMediaItems.firstOrNull()
                        if (item == null) {
                            noMatchResponse()
                        } else {
                            JSObject().apply {
                                put("status", "matched")
                                put("title", item.title)
                                put("artist", item.artist)
                                put("shazamId", item.shazamID)
                                put("isrc", item.isrc)
                                put("appleMusicId", item.appleMusicID)
                                put("artworkUrl", item.artworkURL?.toString())
                                put("genres", JSONArray(item.genres))
                            }
                        }
                    }

                    is MatchResult.NoMatch -> noMatchResponse()
                    is MatchResult.Error -> throw matchResult.exception
                }

                activity.runOnUiThread { call.resolve(response) }
            } catch (cause: Exception) {
                activity.runOnUiThread {
                    call.reject(cause.message ?: "ShazamKit could not identify this track.", null, cause)
                }
            }
        }
    }

    override fun handleOnDestroy() {
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    private fun noMatchResponse() = JSObject().apply {
        put("status", "no-match")
    }
}
