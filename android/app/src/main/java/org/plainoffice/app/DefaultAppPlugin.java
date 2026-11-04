package org.plainoffice.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Helps make Plain Office the app that opens documents.
 *
 * Android doesn't let an app make itself the default. What it does allow:
 *  - checking which app currently opens a file type (status),
 *  - opening a sample file so Android shows its "Open with" list, where the
 *    person picks Plain Office and taps "Always" (choose),
 *  - opening another app's settings, where its default can be cleared (openAppSettings).
 */
@CapacitorPlugin(name = "DefaultApp")
public class DefaultAppPlugin extends Plugin {

    private static final String SAMPLE_DIR = "plain-office-default";
    static final String SAMPLE_NAME = "plain-office-default-check";

    private String authority() {
        return getContext().getPackageName() + ".fileprovider";
    }

    private Intent viewIntent(Uri uri, String mime) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mime);
        intent.addCategory(Intent.CATEGORY_DEFAULT);
        return intent;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSArray types = call.getArray("types");
        if (types == null) {
            call.reject("types is required");
            return;
        }
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        String me = ctx.getPackageName();
        JSArray out = new JSArray();
        try {
            for (int i = 0; i < types.length(); i++) {
                JSONObject type = types.getJSONObject(i);
                String mime = type.getString("mime");
                String ext = type.getString("ext");
                Intent intent = viewIntent(Uri.parse("content://" + authority() + "/check." + ext), mime);

                Set<String> handlers = new HashSet<>();
                List<ResolveInfo> all = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
                for (ResolveInfo info : all) handlers.add(info.activityInfo.packageName);

                ResolveInfo best = pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
                String pkg = best != null && best.activityInfo != null ? best.activityInfo.packageName : null;

                JSObject result = new JSObject();
                result.put("key", type.getString("key"));
                if (me.equals(pkg)) {
                    result.put("state", "ours");
                } else if (pkg != null && handlers.contains(pkg)) {
                    // Another app was picked with "Always".
                    result.put("state", "other");
                    result.put("package", pkg);
                    result.put("app", label(pm, pkg));
                } else {
                    // Android would ask which app to use (pkg is the system's chooser).
                    result.put("state", "none");
                }
                out.put(result);
            }
        } catch (Exception e) {
            call.reject("Could not check the default apps", e);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("types", out);
        call.resolve(ret);
    }

    @PluginMethod
    public void choose(PluginCall call) {
        String mime = call.getString("mime");
        String ext = call.getString("ext");
        String data = call.getString("data");
        if (mime == null || ext == null || data == null) {
            call.reject("mime, ext and data are required");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), SAMPLE_DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("Could not create " + dir);
            File file = new File(dir, SAMPLE_NAME + "." + ext);
            try (FileOutputStream os = new FileOutputStream(file)) {
                os.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), authority(), file);
            Intent intent = viewIntent(uri, mime);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this kind of file", e);
        } catch (Exception e) {
            call.reject("Could not open the sample file", e);
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        String pkg = call.getString("package");
        if (pkg == null) {
            call.reject("package is required");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Could not open that app's settings", e);
        }
    }

    private static String label(PackageManager pm, String pkg) {
        try {
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }
}
