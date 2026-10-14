package com.manxing.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 让前端控制前台服务的启停。
 * 前端在「开始漫游」时调用 start，「结束漫游」时调用 stop。
 *
 * 关键约束：Android 14（API 34）起，前台服务类型要求对应的运行时权限**已经授予**，
 * 而且必须在 startForeground() 之前就满足。顺序不对或权限缺失时系统抛 SecurityException，
 * 这个异常会把整个 App 带崩（这就是「点开始漫游就闪退」的原因）。
 * 因此这里先算清能用哪种类型，一个都不能用时干脆不启动服务，并把原因回给前端。
 */
@CapacitorPlugin(
        name = "KeepAlive",
        permissions = {
                @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
        })
public class KeepAlivePlugin extends Plugin {

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** 按已授予的权限挑出可用的前台服务类型；返回 0 表示一个都不能用。 */
    private int allowedTypes() {
        int types = 0;
        // connectedDevice 需要蓝牙运行时权限；Android 12 以前蓝牙是安装时权限，
        // 只要清单里声明过就是可用的，不受这里限制。
        boolean bluetooth = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || granted(Manifest.permission.BLUETOOTH_CONNECT)
                || granted(Manifest.permission.BLUETOOTH_SCAN)
                || granted(Manifest.permission.BLUETOOTH_ADVERTISE);
        if (bluetooth) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        // location 类型需要定位运行时权限。漫游途中本来就在记录位置，所以这条路通常可用：
        // 用户还没连心率带、没给蓝牙权限时，靠它也能保活。
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        return types;
    }

    @PluginMethod
    public void start(PluginCall call) {
        int types = allowedTypes();
        if (types == 0) {
            // 不能调用 startForegroundService：服务起来后如果没能成功前台化，
            // 系统会判定「startForegroundService 未调用 startForeground」并同样崩掉。
            JSObject denied = new JSObject();
            denied.put("running", false);
            denied.put("reason", "还没有定位或蓝牙权限，本次漫游不做后台保活");
            call.resolve(denied);
            return;
        }
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        intent.putExtra(KeepAliveService.EXTRA_TITLE, call.getString("title", "慢行正在记录"));
        intent.putExtra(KeepAliveService.EXTRA_TEXT, call.getString("text", "心率与定位在后台持续记录中"));
        intent.putExtra(KeepAliveService.EXTRA_TYPES, types);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", KeepAliveService.RUNNING);
        result.put("types", allowedTypes());
        call.resolve(result);
    }
}
