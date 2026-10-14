package com.manxing.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 前台服务：漫游进行中保持进程存活，让心率与定位在锁屏 / 切后台后继续记录。
 *
 * 为什么需要它：Android 会在应用进入后台后限制甚至回收进程，WebView 里的定时器与
 * 蓝牙回调会因此中断。前台服务带一条常驻通知，是官方允许的保活方式。
 *
 * 服务类型由 KeepAlivePlugin 按「已实际授予的权限」算好后通过 EXTRA_TYPES 传进来：
 * Android 14 起，类型对应的运行时权限没授予时 startForeground() 会抛 SecurityException。
 * 这里不再假定类型，也把异常兜住，因为异常一旦逃出 onStartCommand 就是整个 App 闪退。
 */
public class KeepAliveService extends Service {

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_TYPES = "types";
    public static final String CHANNEL_ID = "manxing-keepalive";
    public static final int NOTIFICATION_ID = 20261013;

    private static final String TAG = "ManxingKeepAlive";

    /** 供插件查询当前是否在跑。 */
    public static volatile boolean RUNNING = false;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        int types = intent != null ? intent.getIntExtra(EXTRA_TYPES, 0) : 0;
        createChannel();
        Notification notification = buildNotification(
                title != null ? title : "慢行正在记录",
                text != null ? text : "心率与定位在后台持续记录中");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && types != 0) {
                startForeground(NOTIFICATION_ID, notification, types);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            RUNNING = true;
        } catch (RuntimeException error) {
            // 权限在检查与启动之间被撤销等竞态仍会走到这里。必须兜住并立刻停掉服务：
            // 抛出去会让 App 闪退，留着不停则会被系统判定为「未按期前台化」。
            Log.e(TAG, "前台服务被系统拒绝，本次漫游不做后台保活", error);
            RUNNING = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        RUNNING = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "漫游记录", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("步行过程中保持心率与定位记录");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String title, String text) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launch, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_manxing)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(contentIntent);
        return builder.build();
    }
}
