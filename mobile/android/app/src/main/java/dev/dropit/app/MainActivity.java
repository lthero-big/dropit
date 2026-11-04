package dev.dropit.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin: receives ACTION_SEND / ACTION_SEND_MULTIPLE (share target) and uploads shared files.
        registerPlugin(DropitSharePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
