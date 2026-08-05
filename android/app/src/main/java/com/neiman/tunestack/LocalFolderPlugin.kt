package com.neiman.tunestack

import android.app.Activity
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "LocalFolder")
class LocalFolderPlugin : Plugin() {
    private val audioExtensions = setOf("mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif", "wma")

    @PluginMethod fun pickFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "folderResult")
    }

    @PluginMethod fun pickFiles(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "audio/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "filesResult")
    }

    @ActivityCallback private fun folderResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("documents", JSArray())); return
        }
        persist(uri)
        val root = DocumentFile.fromTreeUri(context, uri)
        val documents = JSArray()
        if (root != null) scan(root, root.name ?: "Music", "", documents)
        call.resolve(JSObject().put("documents", documents))
    }

    @ActivityCallback private fun filesResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val documents = JSArray()
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val clip = data?.clipData
            if (clip != null) for (index in 0 until clip.itemCount) addDocument(clip.getItemAt(index).uri, "", documents)
            else data?.data?.let { addDocument(it, "", documents) }
        }
        call.resolve(JSObject().put("documents", documents))
    }

    private fun scan(directory: DocumentFile, folderName: String, path: String, output: JSArray) {
        directory.listFiles().forEach { file ->
            val name = file.name.orEmpty()
            val nextPath = if (path.isEmpty()) name else path + "/" + name
            if (file.isDirectory) scan(file, file.name ?: folderName, nextPath, output)
            else if (isAudio(file)) addDocument(file.uri, path, output, folderName)
        }
    }

    private fun isAudio(file: DocumentFile): Boolean {
        if (file.type?.startsWith("audio/") == true) return true
        return file.name?.substringAfterLast('.', "")?.lowercase() in audioExtensions
    }

    private fun persist(uri: Uri) {
        try { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        catch (_: SecurityException) { }
    }

    private fun addDocument(uri: Uri, relativePath: String, output: JSArray, folderName: String = "") {
        persist(uri)
        val file = DocumentFile.fromSingleUri(context, uri) ?: return
        val item = JSObject()
        item.put("uri", uri.toString())
        item.put("name", file.name ?: "Unknown track")
        item.put("relativePath", if (relativePath.isEmpty()) file.name ?: "" else relativePath + "/" + (file.name ?: ""))
        item.put("folderName", folderName)
        item.put("mimeType", file.type ?: "audio/*")
        item.put("size", file.length())
        val metadata = MediaMetadataRetriever()
        try {
            metadata.setDataSource(context, uri)
            item.put("title", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE) ?: "")
            item.put("artist", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST) ?: "")
            item.put("album", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM) ?: "")
            item.put("genre", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_GENRE) ?: "")
            item.put("year", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR)?.toIntOrNull() ?: 0)
            item.put("durationMs", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0)
        } catch (_: Exception) { }
        finally { try { metadata.release() } catch (_: Exception) { } }
        output.put(item)
    }
}
