package com.manxing.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 让前端控制前台服务的启停。
 * 前端在「开始漫游」时调用 start，「结束漫游」时调用 stop。
 */
@CapacitorPlugin(
        name = "KeepAlive",
        permissions = {
                @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
        })
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        intent.putExtra(KeepAliveService.EXTRA_TITLE, call.getString("title", "慢行正在记录"));
        intent.putExtra(KeepAliveService.EXTRA_TEXT, call.getString("text", "心率与定位在后台持续记录中"));
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
        call.resolve(result);
    }
}
