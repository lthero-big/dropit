package dev.dropit.app.data.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.dropit.app.DropitApplication
import dev.dropit.app.R
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import kotlinx.coroutines.CancellationException
import kotlin.math.roundToInt

/**
 * Abstraction for scheduling durable transfer execution (WorkManager in production,
 * direct/in-memory runner in JVM unit tests).
 */
interface TransferWorkScheduler {
    fun enqueue(taskId: String)
    fun cancel(taskId: String)
    fun cancelAll()
    suspend fun isWorkActive(taskId: String): Boolean
}

class AndroidTransferWorkScheduler(
    context: Context,
) : TransferWorkScheduler {
    private val appContext = context.applicationContext
    private val workManager: WorkManager by lazy { WorkManager.getInstance(appContext) }

    override fun enqueue(taskId: String) {
        val request = OneTimeWorkRequestBuilder<TransferWorker>()
            .setInputData(workDataOf(TransferWorker.KEY_TASK_ID to taskId))
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(TAG_ALL_TRANSFERS)
            .addTag(taskTag(taskId))
            .build()

        workManager.enqueueUniqueWork(
            uniqueWorkName(taskId),
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    override fun cancel(taskId: String) {
        workManager.cancelUniqueWork(uniqueWorkName(taskId))
    }

    override fun cancelAll() {
        workManager.cancelAllWorkByTag(TAG_ALL_TRANSFERS)
    }

    override suspend fun isWorkActive(taskId: String): Boolean {
        return runCatching {
            val infos = workManager.getWorkInfosForUniqueWork(uniqueWorkName(taskId)).get()
            infos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }
        }.getOrDefault(false)
    }

    companion object {
        const val TAG_ALL_TRANSFERS = "dropit_transfers"
        fun uniqueWorkName(taskId: String): String = "dropit_transfer_$taskId"
        fun taskTag(taskId: String): String = "dropit_transfer_task_$taskId"
    }
}

/**
 * WorkManager CoroutineWorker driving durable chunked uploads and Range downloads.
 * Posts progress notifications with a cancel action and complies with Android 14+ foreground
 * dataSync guidelines while degrading safely if background foreground-service start is restricted.
 */
class TransferWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

    private val notificationId: Int = (NOTIFICATION_BASE_ID + (workerParams.id.hashCode() and 0x0FFF))

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val taskId = inputData.getString(KEY_TASK_ID).orEmpty()
        return buildForegroundInfo(
            title = "正在传输文件",
            contentText = if (taskId.isNotEmpty()) "正在准备任务…" else "dropit 传输队列",
            progressPercent = null,
        )
    }

    override suspend fun doWork(): Result {
        val taskId = inputData.getString(KEY_TASK_ID)?.takeIf { it.isNotBlank() }
            ?: return Result.failure()
        val app = applicationContext as? DropitApplication ?: return Result.failure()
        val manager = app.container.transferManager as? DefaultTransferManager ?: return Result.failure()

        ensureChannel()
        val initialEntity = manager.getTaskEntity(taskId) ?: return Result.success()
        val directionLabel = if (initialEntity.toDirection() == TransferDirection.UPLOAD) "正在上传" else "正在下载"
        val displayTitle = "$directionLabel ${initialEntity.fileName}"

        // Best-effort foreground promotion (Android 14+ requires foregroundServiceType = dataSync).
        runCatching {
            setForeground(
                buildForegroundInfo(
                    title = displayTitle,
                    contentText = "准备中…",
                    progressPercent = 0,
                ),
            )
        }

        var lastNotifyMs = 0L
        return try {
            val outcome = manager.executeTaskFromWorker(taskId) { entity, metrics ->
                val now = System.currentTimeMillis()
                val percent = if (entity.totalBytes > 0L) {
                    ((metrics.transferredBytes.toDouble() / entity.totalBytes.toDouble()) * 100.0)
                        .roundToInt()
                        .coerceIn(0, 100)
                } else {
                    0
                }
                if (now - lastNotifyMs >= NOTIFY_THROTTLE_MS || percent >= 100) {
                    lastNotifyMs = now
                    val speedPart = if (metrics.speedBytesPerSec > 0L) {
                        " · ${ServerUrl.formatSize(metrics.speedBytesPerSec)}/s"
                    } else {
                        ""
                    }
                    val etaPart = metrics.etaSeconds?.takeIf { it > 0L }?.let { " · 剩余 ${formatEta(it)}" }.orEmpty()
                    val text = "$percent%$speedPart$etaPart"
                    postProgressNotification(displayTitle, text, percent)
                }
            }

            when (outcome) {
                TransferExecutionOutcome.Succeeded,
                TransferExecutionOutcome.AlreadyCompleted,
                TransferExecutionOutcome.NotFound,
                -> {
                    clearNotification()
                    Result.success()
                }

                TransferExecutionOutcome.Cancelled -> {
                    clearNotification()
                    Result.success()
                }

                is TransferExecutionOutcome.Failed -> {
                    postTerminalNotification(
                        title = "${if (initialEntity.toDirection() == TransferDirection.UPLOAD) "上传" else "下载"}失败：${initialEntity.fileName}",
                        contentText = outcome.message,
                    )
                    Result.failure()
                }
            }
        } catch (ce: CancellationException) {
            // Distinguish user cancel from system stop: if cancelled via notification button,
            // trigger manager.cancel so remote upload session & staged file are cleaned up.
            val latest = runCatching { manager.getTaskEntity(taskId) }.getOrNull()
            if (isStopped && latest != null && latest.toStatus() != TransferStatus.CANCELLED) {
                val stopReason = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) stopReason else 0
                if (stopReason == WorkInfo.STOP_REASON_CANCELLED_BY_APP) {
                    runCatching { manager.cancel(taskId) }
                }
            }
            clearNotification()
            throw ce
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "文件传输进度",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "显示 dropit 文件上传与下载进度"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(
        title: String,
        contentText: String,
        progressPercent: Int?,
        ongoing: Boolean,
    ): Notification {
        ensureChannel()
        val cancelIntent = WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
        val builder = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(contentText)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (ongoing) {
            if (progressPercent != null) {
                builder.setProgress(100, progressPercent.coerceIn(0, 100), false)
            } else {
                builder.setProgress(0, 0, true)
            }
            builder.addAction(0, "取消", cancelIntent)
        }
        return builder.build()
    }

    private fun buildForegroundInfo(
        title: String,
        contentText: String,
        progressPercent: Int?,
    ): ForegroundInfo {
        val notification = buildNotification(title, contentText, progressPercent, ongoing = true)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId, notification)
        }
    }

    private fun postProgressNotification(title: String, contentText: String, progressPercent: Int) {
        val notification = buildNotification(title, contentText, progressPercent, ongoing = true)
        runCatching { NotificationManagerCompat.from(applicationContext).notify(notificationId, notification) }
    }

    private fun postTerminalNotification(title: String, contentText: String) {
        val notification = buildNotification(title, contentText, progressPercent = null, ongoing = false)
        runCatching { NotificationManagerCompat.from(applicationContext).notify(notificationId, notification) }
    }

    private fun clearNotification() {
        runCatching { NotificationManagerCompat.from(applicationContext).cancel(notificationId) }
    }

    companion object {
        const val KEY_TASK_ID = "task_id"
        const val CHANNEL_ID = "dropit_transfers"
        private const val NOTIFICATION_BASE_ID = 25500
        private const val NOTIFY_THROTTLE_MS = 500L

        internal fun formatEta(seconds: Long): String = when {
            seconds < 60L -> "${seconds}秒"
            seconds < 3600L -> "${seconds / 60}分${seconds % 60}秒"
            else -> "${seconds / 3600}小时${(seconds % 3600) / 60}分"
        }
    }
}
