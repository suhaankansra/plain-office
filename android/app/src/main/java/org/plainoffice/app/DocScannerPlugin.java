package org.plainoffice.app;

import android.app.Activity;
import android.net.Uri;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Opens Android's own document scanner, the one Google Drive and Files by Google
 * use. It finds the page edges, straightens and cleans up the pages on the phone,
 * and hands back one JPEG per page.
 *
 * It comes with Google Play services. Phones without them reject with
 * "UNAVAILABLE", and the app uses its own scanner instead.
 */
@CapacitorPlugin(name = "DocScanner")
public class DocScannerPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        // Must be registered while the activity is being created, which is when plugins load.
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), (result) -> {
            PluginCall call = pending;
            pending = null;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK) {
                call.resolve(pagesResult(new JSArray()));
                return;
            }
            GmsDocumentScanningResult scan = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
            JSArray pages = new JSArray();
            if (scan != null && scan.getPages() != null) {
                File dir = new File(getContext().getCacheDir(), "scans");
                dir.mkdirs();
                long stamp = System.currentTimeMillis();
                int n = 0;
                try {
                    for (GmsDocumentScanningResult.Page page : scan.getPages()) {
                        File out = new File(dir, "scan-" + stamp + "-" + (n++) + ".jpg");
                        copy(page.getImageUri(), out);
                        pages.put(Uri.fromFile(out).toString());
                    }
                } catch (Exception e) {
                    call.reject("Could not read the scanned pages", e);
                    return;
                }
            }
            call.resolve(pagesResult(pages));
        });
    }

    private JSObject pagesResult(JSArray pages) {
        JSObject ret = new JSObject();
        ret.put("pages", pages);
        return ret;
    }

    private void copy(Uri from, File to) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[64 * 1024];
            int len;
            while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (pending != null) {
            call.reject("A scan is already open");
            return;
        }
        // Old scans from earlier sessions are no longer needed.
        File[] old = new File(getContext().getCacheDir(), "scans").listFiles();
        if (old != null) for (File f : old) f.delete();

        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(Math.max(1, Math.min(100, call.getInt("pageLimit", 100))))
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        scanner
            .getStartScanIntent(getActivity())
            .addOnSuccessListener((intentSender) -> {
                pending = call;
                launcher.launch(new IntentSenderRequest.Builder(intentSender).build());
            })
            .addOnFailureListener((e) -> call.reject("The phone's document scanner isn't available", "UNAVAILABLE", e));
    }
}
