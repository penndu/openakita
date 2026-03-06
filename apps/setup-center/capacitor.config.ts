import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.openakita.mobile",
  appName: "OpenAkita",
  webDir: "dist-web",
  server: {
    androidScheme: "http",
    iosScheme: "http",
    allowNavigation: ["*"],
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    CapacitorCookies: {
      enabled: true,
    },
  },
};

export default config;
