package desktop

import (
	_ "embed"
	"net/http"
	"net/url"
	"strings"
)

const nativeRuntimePath = "/wails/runtime"
const nativeRuntimeProofHeader = "X-BetterComms-Page-Proof"

//go:embed runtime_fetch.js
var nativeRuntimeFetchScript string

// NativeRuntimeMiddleware protects Wails' HTTP dispatcher before its internal
// middlewares run. Wails assigns requests from all frames the same window ID;
// that ID is not proof that the caller is the application's own document.
// Raw platform messages are a separate boundary, not covered by this gate.
func NativeRuntimeMiddleware(gate *PageGate, development bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != nativeRuntimePath && !strings.HasPrefix(r.URL.Path, nativeRuntimePath+"/") {
				next.ServeHTTP(w, r)
				return
			}
			// Neither escaped aliases nor descendants are native RPC routes.
			if r.URL.EscapedPath() != nativeRuntimePath ||
				len(r.Header.Values(nativeRuntimeProofHeader)) != 1 ||
				gate.Authorise(r.Header.Get(nativeRuntimeProofHeader)) != nil ||
				!nativeRuntimeSourceAllowed(r, development) {
				w.Header().Set("Cache-Control", "no-store")
				http.Error(w, "native runtime caller is not authorised", http.StatusForbidden)
				return
			}
			// The pinned SDK uses POST, including chunked binding calls. Retain
			// authenticated GET query calls for older/custom-scheme runtimes.
			if r.Method != http.MethodPost && r.Method != http.MethodGet {
				w.Header().Set("Allow", "GET, POST")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			// The launch proof is not an argument for bindings or framework logs.
			trusted := r.Clone(r.Context())
			trusted.Header.Del(nativeRuntimeProofHeader)
			next.ServeHTTP(w, trusted)
		})
	}
}

func nativeRuntimeSourceAllowed(r *http.Request, development bool) bool {
	// The native asset adapter clears URL scheme/host, but preserves the
	// virtual request Host. Opaque/missing Origin is not a reason to admit an
	// arbitrary host even when a caller has copied the launch proof.
	if !nativeRuntimeHostAllowed(r.Host, development) || len(r.Header.Values("Origin")) > 1 {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "null" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" ||
			parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" ||
			parsed.Host != r.Host {
			return false
		}
		trusted, err := TrustedAppOrigin(origin, development)
		if err != nil || trusted != origin || trusted == ReleaseOrigin ||
			(parsed.Scheme == "wails" && parsed.Host != "localhost" && parsed.Host != "wails") {
			return false
		}
	}
	// Missing/null Origin occurs with native custom schemes. It is admitted
	// only after the per-launch possession proof above has been checked.
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "same-site", "none":
	default:
		return false
	}
	switch r.Header.Get("Sec-Fetch-Dest") {
	case "", "empty":
	default:
		return false
	}
	return true
}

func nativeRuntimeHostAllowed(host string, development bool) bool {
	// beta.18 uses localhost for Darwin/Linux's wails: asset authority and
	// wails.localhost for WebView2. Keep the repository's older wails: alias
	// explicit; neither arbitrary wails: authorities nor ports are trusted.
	return host == "localhost" || host == "wails.localhost" || host == "wails" ||
		(development && host == "localhost:5173")
}
