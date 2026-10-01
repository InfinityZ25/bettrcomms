package com.wails.app;

import java.net.URI;

final class TrustedPage {
    static boolean packaged(String address) {
        try {
            URI uri = URI.create(address);
            return "https".equals(uri.getScheme()) && "wails.localhost".equals(uri.getHost())
                    && uri.getRawUserInfo() == null && uri.getPort() == -1;
        } catch (IllegalArgumentException e) { return false; }
    }
    static boolean resource(String address) {
        if (packaged(address)) return true;
        try {
            URI uri = URI.create(address);
            if (uri.getRawUserInfo() != null) return false;
            if ("https".equals(uri.getScheme())) return uri.getHost() != null;
            return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                    && uri.getPort() > 0 && uri.getPath().startsWith("/api/");
        } catch (IllegalArgumentException e) { return false; }
    }
}
