package org.plainoffice.app;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup.MarginLayoutParams;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DefaultAppPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBarColors();
        // Android 15+ draws apps edge to edge and no longer shrinks them for the
        // keyboard. Keep the web view clear of the system bars and above the
        // keyboard, so the editing toolbars stay visible while typing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            ViewCompat.setOnApplyWindowInsetsListener(getBridge().getWebView(), (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                MarginLayoutParams params = (MarginLayoutParams) v.getLayoutParams();
                params.leftMargin = bars.left;
                params.topMargin = bars.top;
                params.rightMargin = bars.right;
                params.bottomMargin = Math.max(bars.bottom, ime.bottom);
                v.setLayoutParams(params);
                return WindowInsetsCompat.CONSUMED;
            });
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarColors();
    }

    // The strips behind the status and navigation bars match the app's top and
    // bottom bars, in light and dark mode.
    private void applySystemBarColors() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        getWindow().getDecorView().setBackgroundColor(night ? 0xFF1F2226 : 0xFFFFFFFF);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(!night);
        controller.setAppearanceLightNavigationBars(!night);
    }
}
