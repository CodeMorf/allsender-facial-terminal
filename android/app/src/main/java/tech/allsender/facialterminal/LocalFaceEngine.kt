package tech.allsender.facialterminal

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.util.Base64
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.nio.FloatBuffer
import kotlin.math.sqrt

/**
 * SFace local identity encoder.
 *
 * MediaPipe remains responsible for live face detection in the existing PWA.
 * This class only runs the signed-in-package SFace encoder and compares its
 * normalized 128-vector against templates belonging to the paired branch.
 */
object LocalFaceEngine {
    private const val MODEL_ASSET = "face_recognition_sface_2021dec_int8bq.onnx"
    private const val MODEL_NAME = "opencv_sface_v1"
    private const val SIMILARITY_THRESHOLD = 0.363f
    private const val MIN_MARGIN = 0.025f
    private const val IMAGE_SIZE = 112

    private val lock = Any()
    private var environment: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var inputName: String? = null

    fun isAvailable(context: Context): Boolean {
        return try {
            session(context) != null
        } catch (_: Exception) {
            false
        }
    }

    fun recognize(context: Context, imageDataUrl: String, request: JSONObject): JSONObject? {
        val branchId = request.optString("branch_id")
        if (branchId.isBlank()) return null
        val landmarks = readLandmarks(request.optJSONArray("landmarks"), request)
            ?: return null
        val bitmap = decodeImage(imageDataUrl) ?: return null
        return try {
            val aligned = align(bitmap, landmarks)
            val candidate = infer(context, aligned)
            compare(candidate, branchId, loadTemplates(context, branchId))
        } finally {
            if (!bitmap.isRecycled) bitmap.recycle()
        }
    }

    private fun session(context: Context): OrtSession? {
        synchronized(lock) {
            if (session != null) return session
            val model = context.applicationContext.assets.open(MODEL_ASSET).use { it.readBytes() }
            val env = OrtEnvironment.getEnvironment()
            val options = OrtSession.SessionOptions()
            val created = env.createSession(model, options)
            environment = env
            session = created
            inputName = created.inputNames.firstOrNull()
            return created
        }
    }

    private fun decodeImage(dataUrl: String): Bitmap? {
        val comma = dataUrl.indexOf(',')
        val encoded = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
        if (encoded.isBlank()) return null
        return try {
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Exception) {
            null
        }
    }

    private data class Point(val x: Float, val y: Float)

    private fun readLandmarks(array: JSONArray?, request: JSONObject): Array<Point>? {
        if (array == null || array.length() != 5) return null
        val width = request.optDouble("image_width", 0.0)
        val height = request.optDouble("image_height", 0.0)
        val points = ArrayList<Point>(5)
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: return null
            var x = item.optDouble("x", Double.NaN)
            var y = item.optDouble("y", Double.NaN)
            if (!x.isFinite() || !y.isFinite()) return null
            // MediaPipe reports normalized coordinates. Pixel coordinates are
            // also accepted for a future native camera path.
            if (x in 0.0..1.0 && y in 0.0..1.0 && width > 1.0 && height > 1.0) {
                x *= width
                y *= height
            }
            if (x < 0.0 || y < 0.0 || x >= width || y >= height) return null
            points += Point(x.toFloat(), y.toFloat())
        }
        return points.toTypedArray()
    }

    /** Similarity transform equivalent to OpenCV FaceRecognizerSF.alignCrop. */
    private fun align(source: Bitmap, points: Array<Point>): Bitmap {
        val destination = arrayOf(
            Point(38.2946f, 51.6963f),
            Point(73.5318f, 51.5014f),
            Point(56.0252f, 71.7366f),
            Point(41.5493f, 92.3655f),
            Point(70.7299f, 92.2041f),
        )
        var srcMeanX = 0f
        var srcMeanY = 0f
        var dstMeanX = 0f
        var dstMeanY = 0f
        points.indices.forEach { index ->
            srcMeanX += points[index].x
            srcMeanY += points[index].y
            dstMeanX += destination[index].x
            dstMeanY += destination[index].y
        }
        srcMeanX /= points.size
        srcMeanY /= points.size
        dstMeanX /= points.size
        dstMeanY /= points.size

        var a = 0f
        var b = 0f
        var denominator = 0f
        points.indices.forEach { index ->
            val sx = points[index].x - srcMeanX
            val sy = points[index].y - srcMeanY
            val dx = destination[index].x - dstMeanX
            val dy = destination[index].y - dstMeanY
            a += sx * dx + sy * dy
            b += sx * dy - sy * dx
            denominator += sx * sx + sy * sy
        }
        val safeDenominator = denominator.coerceAtLeast(0.0001f)
        val cos = a / safeDenominator
        val sin = b / safeDenominator
        val tx = dstMeanX - cos * srcMeanX + sin * srcMeanY
        val ty = dstMeanY - sin * srcMeanX - cos * srcMeanY
        val transform = Matrix().apply {
            setValues(floatArrayOf(cos, -sin, tx, sin, cos, ty, 0f, 0f, 1f))
        }
        return Bitmap.createBitmap(IMAGE_SIZE, IMAGE_SIZE, Bitmap.Config.ARGB_8888).also { output ->
            Canvas(output).drawBitmap(source, transform, Paint(Paint.FILTER_BITMAP_FLAG))
        }
    }

    private fun infer(context: Context, bitmap: Bitmap): FloatArray {
        val values = FloatArray(3 * IMAGE_SIZE * IMAGE_SIZE)
        var offset = 0
        // OpenCV's SFace reference uses blobFromImage(..., swapRB=true), so
        // the ONNX tensor is RGB NCHW with the original 0..255 range.
        for (channel in 0..2) {
            for (y in 0 until IMAGE_SIZE) {
                for (x in 0 until IMAGE_SIZE) {
                    val pixel = bitmap.getPixel(x, y)
                    values[offset++] = when (channel) {
                        0 -> android.graphics.Color.red(pixel).toFloat()
                        1 -> android.graphics.Color.green(pixel).toFloat()
                        else -> android.graphics.Color.blue(pixel).toFloat()
                    }
                }
            }
        }
        val ortSession = session(context) ?: return FloatArray(0)
        val name = inputName ?: return FloatArray(0)
        val ortEnvironment = environment ?: return FloatArray(0)
        var output = emptyList<Float>()
        OnnxTensor.createTensor(
            ortEnvironment,
            FloatBuffer.wrap(values),
            longArrayOf(1, 3, IMAGE_SIZE.toLong(), IMAGE_SIZE.toLong()),
        ).use { tensor ->
            ortSession.run(mapOf(name to tensor)).use { result ->
                output = flatten(result[0].value)
            }
        }
        if (output.size != 128) return FloatArray(0)
        val norm = sqrt(output.sumOf { it.toDouble() * it.toDouble() }).toFloat()
        if (!norm.isFinite() || norm <= 0f) return FloatArray(0)
        return FloatArray(output.size) { output[it] / norm }
    }

    private fun flatten(value: Any?): List<Float> = when (value) {
        is FloatArray -> value.toList()
        is DoubleArray -> value.map { it.toFloat() }
        is IntArray -> value.map { it.toFloat() }
        is LongArray -> value.map { it.toFloat() }
        is Array<*> -> value.flatMap(::flatten)
        is Number -> listOf(value.toFloat())
        else -> emptyList()
    }

    /** Reads the encrypted branch catalog from Room; embeddings never cross the JS bridge. */
    private fun loadTemplates(context: Context, branchId: String): JSONArray {
        val rows = runBlocking(Dispatchers.IO) {
            LocalDatabase.get(context).faceTemplates().forBranch(branchId)
        }
        val secureStore = SecureStore(context)
        return JSONArray().also { result ->
            rows.forEach { row ->
                secureStore.decrypt(row.encryptedPayload)?.let { payload ->
                    try {
                        val item = JSONObject(payload)
                        if (item.optString("branch_id") == branchId &&
                            item.optString("model_name") == MODEL_NAME &&
                            item.optBoolean("active", false)
                        ) {
                            result.put(item)
                        }
                    } catch (_: Exception) {
                        // Ignore one corrupt local row; another authorized profile may still match.
                    }
                }
            }
        }
    }

    private fun compare(candidate: FloatArray, branchId: String, templates: JSONArray?): JSONObject? {
        if (candidate.size != 128 || templates == null) return null
        var bestId: String? = null
        var best = -1f
        var second = -1f
        for (index in 0 until templates.length()) {
            val item = templates.optJSONObject(index) ?: continue
            if (item.optString("branch_id") != branchId ||
                item.optString("model_name") != MODEL_NAME ||
                !item.optBoolean("active", false)
            ) continue
            val embeddings = item.optJSONArray("embeddings") ?: continue
            for (embeddingIndex in 0 until embeddings.length()) {
                val vectorArray = embeddings.optJSONArray(embeddingIndex) ?: continue
                if (vectorArray.length() != 128) continue
                var score = 0f
                var norm = 0f
                for (part in 0 until vectorArray.length()) {
                    val value = vectorArray.optDouble(part, Double.NaN).toFloat()
                    if (!value.isFinite()) {
                        norm = -1f
                        break
                    }
                    score += value * candidate[part]
                    norm += value * value
                }
                if (norm <= 0f) continue
                score /= sqrt(norm)
                if (score > best) {
                    second = best
                    best = score
                    bestId = item.optString("employee_id").takeIf { it.isNotBlank() }
                } else if (score > second) {
                    second = score
                }
            }
        }
        if (bestId == null || best < SIMILARITY_THRESHOLD || (second >= 0f && best - second < MIN_MARGIN)) return null
        return JSONObject()
            .put("employee_id", bestId)
            .put("confidence", best.toDouble())
            .put("engine", MODEL_NAME)
    }
}
