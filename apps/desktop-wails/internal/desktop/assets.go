package desktop

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
)

// bootGlobal is the page global the shared frontend reads synchronously to
// decide which desktop runtime it is on. Injecting it beats sniffing the user
// agent or a Wails-internal global: it is this host's own contract, it arrives
// before the first script runs, and the frontend validates it.
const bootGlobal = "__BETTERCOMMS_DESKTOP__"

// InjectBootReport returns html with the boot global inserted at the start of
// <head>, so it is defined before any bundle executes.
//
// The report is embedded as a JSON string that the page parses, rather than as
// a JavaScript object literal. A string literal has exactly one escaping rule
// to get right, and JSON.parse cannot execute anything, so a hostile value in
// the report — a window title, an error message from a bad origin — cannot
// become script.
func InjectBootReport(html []byte, report BootReport) ([]byte, error) {
	source, err := bootReportScript(report)
	if err != nil {
		return nil, err
	}
	script := []byte("<script>" + string(source) + "</script>")
	if idx := headInsertionPoint(html); idx >= 0 {
		out := make([]byte, 0, len(html)+len(script))
		out = append(out, html[:idx]...)
		out = append(out, script...)
		out = append(out, html[idx:]...)
		return out, nil
	}
	return append(script, html...), nil
}

func bootReportScript(report BootReport) ([]byte, error) {
	encoded, err := json.Marshal(report)
	if err != nil {
		return nil, fmt.Errorf("encode boot report: %w", err)
	}
	// Marshal the JSON text again to get a safe JavaScript string literal, then
	// neutralise the sequences that would end the enclosing <script> element.
	literal, err := json.Marshal(string(encoded))
	if err != nil {
		return nil, fmt.Errorf("encode boot literal: %w", err)
	}
	// encoding/json already escapes these three, but the guarantee is restated
	// here rather than inherited: a literal "<" inside the script element could
	// close it. The replacements are ordinary JSON escapes, so JSON.parse
	// restores the original characters.
	literal = escapeForScript(literal)

	return []byte("window." + bootGlobal + "=JSON.parse(" + string(literal) + ");"), nil
}

// CSP constrains document content, not top-level navigation. Development keeps
// Vite's inline refresh preamble; packaged scripts are local modules plus the
// exact boot script hash, never unrestricted inline JavaScript or eval.
func documentContentPolicy(report BootReport, development bool) (string, error) {
	base := "base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'"
	if development {
		return base, nil
	}
	script, err := bootReportScript(report)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(script)
	return base + "; default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' 'sha256-" +
		base64.StdEncoding.EncodeToString(digest[:]) + "'; worker-src 'self' blob:; " +
		"style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; " +
		"media-src 'self' blob: mediastream:; connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:*", nil
}

// escapeForScript replaces <, > and & with their JSON unicode escapes. The
// replacements are built from bytes so the escape text itself cannot be
// mangled by an editor or a source transform.
func escapeForScript(literal []byte) []byte {
	esc := func(hi, lo byte) []byte { return []byte{'\\', 'u', '0', '0', hi, lo} }
	literal = bytes.ReplaceAll(literal, []byte{'<'}, esc('3', 'c'))
	literal = bytes.ReplaceAll(literal, []byte{'>'}, esc('3', 'e'))
	literal = bytes.ReplaceAll(literal, []byte{'&'}, esc('2', '6'))
	return literal
}

// headInsertionPoint finds the offset just after <head ...>, or -1.
func headInsertionPoint(html []byte) int {
	lower := bytes.ToLower(html)
	idx := bytes.Index(lower, []byte("<head"))
	if idx < 0 {
		return -1
	}
	end := bytes.IndexByte(lower[idx:], '>')
	if end < 0 {
		return -1
	}
	return idx + end + 1
}

// AssetOptions configures the handler that serves the shared frontend.
type AssetOptions struct {
	// Dist is the built frontend (apps/web/dist), embedded or on disk. It is
	// ignored when DevServer is set.
	Dist fs.FS
	// DevServer is the Vite origin to proxy during development. When set, the
	// frontend is served live from apps/web rather than from a copy.
	DevServer string
	// Boot produces the report injected into every HTML document.
	Boot func() BootReport
}

// NewAssetHandler builds the host's single HTTP handler: the desktop bridge,
// then the frontend, with the boot report injected into HTML on the way out.
func NewAssetHandler(opts AssetOptions) (http.Handler, error) {
	var frontend http.Handler
	if opts.DevServer != "" {
		proxy, err := newDevProxy(opts.DevServer)
		if err != nil {
			return nil, err
		}
		frontend = proxy
	} else {
		if opts.Dist == nil {
			return nil, fmt.Errorf("no frontend assets: build apps/web and stage its dist directory")
		}
		frontend = newStaticHandler(opts.Dist)
	}

	injecting := &htmlInjector{next: frontend, boot: opts.Boot, development: opts.DevServer != ""}

	mux := http.NewServeMux()
	if opts.DevServer == "" {
		// A packaged host serves the frontend from its own origin, where no API
		// exists. Without this, "/api/..." would fall through to the SPA
		// fallback and the client would parse an HTML document as a response.
		// Reaching here means the client ignored the boot report's apiBase, so
		// say which contract it missed rather than returning a document.
		mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusNotImplemented, map[string]string{
				"error": "this desktop host serves no API on its page origin; use the boot report's apiBase and apiToken",
			})
		})
	}
	mux.Handle("/", injecting)
	return mux, nil
}

// newDevProxy forwards to the Vite dev server. Compression is refused on the
// hop so HTML can be rewritten without decoding it first.
func newDevProxy(devServer string) (http.Handler, error) {
	target, err := url.Parse(devServer)
	if err != nil {
		return nil, fmt.Errorf("invalid dev server URL %q: %w", devServer, err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Host = target.Host
		r.Header.Set("Accept-Encoding", "identity")
	}
	return proxy, nil
}

// newStaticHandler serves the built frontend and falls back to index.html for
// unknown paths, which keeps deep links working.
func newStaticHandler(dist fs.FS) http.Handler {
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(dist, name); err != nil {
			// Serve the root rather than "/index.html": net/http redirects the
			// explicit index path to "./", which would turn a deep link into a
			// 301 instead of the application document.
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
}

// htmlInjector buffers HTML responses so the boot report can be inserted, and
// streams everything else through untouched.
type htmlInjector struct {
	next        http.Handler
	boot        func() BootReport
	development bool
}

func (h *htmlInjector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !mayBeDocument(r) {
		// Buffering would break the dev server's HMR socket, which needs the
		// real ResponseWriter to be hijackable, and it would needlessly hold
		// large assets in memory.
		h.next.ServeHTTP(w, r)
		return
	}

	capture := &bufferedResponse{header: http.Header{}}
	h.next.ServeHTTP(capture, r)
	if capture.status == 0 {
		// A handler that wrote nothing at all still produced a 200.
		capture.status = http.StatusOK
	}

	body := capture.body.Bytes()
	contentType := capture.header.Get("Content-Type")
	if h.boot != nil && capture.status == http.StatusOK && strings.Contains(contentType, "text/html") {
		report := h.boot()
		injected, err := InjectBootReport(body, report)
		if err != nil {
			http.Error(w, "desktop boot configuration unavailable", http.StatusInternalServerError)
			return
		}
		policy, err := documentContentPolicy(report, h.development)
		if err != nil {
			http.Error(w, "desktop content policy unavailable", http.StatusInternalServerError)
			return
		}
		body = injected
		capture.header.Set("Content-Security-Policy", policy)
		capture.header.Set("Referrer-Policy", "no-referrer")
		capture.header.Set("X-Content-Type-Options", "nosniff")
		capture.header.Set("Cache-Control", "no-store")
	}

	for key, values := range capture.header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Del("Content-Length")
	w.WriteHeader(capture.status)
	_, _ = w.Write(body)
}

// mayBeDocument reports whether a request could plausibly return the
// application document. Everything else — sockets, modules, worklets, WASM,
// media — is streamed straight through.
func mayBeDocument(r *http.Request) bool {
	if r.Method != http.MethodGet || r.Header.Get("Upgrade") != "" {
		return false
	}
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		return true
	}
	// A webview that sends no Accept still has to receive the document, and a
	// route such as "/rooms/42" has no extension to distinguish it from one.
	return path.Ext(path.Base(r.URL.Path)) == ""
}

type bufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (b *bufferedResponse) Header() http.Header { return b.header }

func (b *bufferedResponse) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

var _ io.Writer = (*bufferedResponse)(nil)
