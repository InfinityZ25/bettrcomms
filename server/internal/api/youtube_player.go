package api

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var playerNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)
var playerHostnamePattern = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

const productionPlayerHostname = "player.bettrcomms.com"

func playerAuthority(authority string) (hostname, port string, valid bool) {
	if authority == "" || strings.ContainsAny(authority, " \t\r\n/\\?#@%") || strings.HasSuffix(authority, ":") {
		return "", "", false
	}
	u, err := url.Parse("https://" + authority)
	if err != nil || u.Host != authority || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", "", false
	}
	hostname, port = u.Hostname(), u.Port()
	if strings.HasPrefix(authority, "[") && (!strings.Contains(hostname, ":") || net.ParseIP(hostname) == nil) {
		return "", "", false
	}
	if len(hostname) > 253 || !playerHostnamePattern.MatchString(hostname) && net.ParseIP(hostname) == nil {
		return "", "", false
	}
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
			return "", "", false
		}
	}
	return strings.ToLower(hostname), port, true
}

func playerParentAllowed(origin, app string) bool {
	u, err := url.Parse(app)
	if err == nil && origin == u.Scheme+"://"+u.Host {
		return true
	}
	return origin == "http://wails.localhost" || origin == "https://wails.localhost" || origin == "wails://wails" || origin == "null"
}
func (a *API) mintYouTubePlayerTicket(w http.ResponseWriter, r *http.Request, user User, room string) {
	if a.Config.YouTubePlayerOrigin == "" {
		a.fail(w, 503, "youtube_unavailable", "YouTube playback is not configured")
		return
	}
	var in struct {
		PlaybackID   string `json:"playback_id"`
		Nonce        string `json:"nonce"`
		ParentOrigin string `json:"parent_origin"`
	}
	if !a.decode(w, r, &in) {
		return
	}
	if !uuidPattern.MatchString(in.PlaybackID) || !playerNoncePattern.MatchString(in.Nonce) || !playerParentAllowed(in.ParentOrigin, a.Config.AppURL) {
		a.fail(w, 400, "invalid_player", "Invalid player bootstrap")
		return
	}
	session, err := a.Sessions.Resolve(r)
	if err != nil || session.UserID != user.ID || session.ID == "" {
		a.fail(w, 401, "unauthorized", "Sign in again to open the player")
		return
	}
	ticket, err := randomToken()
	if err != nil {
		a.result(w, nil, err)
		return
	}
	hash := sha256.Sum256([]byte(ticket))
	s := a.Store.(*PostgresStore)
	tag, err := s.DB.Exec(r.Context(), `INSERT INTO youtube_player_tickets(ticket_hash,user_id,session_id,room_id,playback_id,youtube_id,parent_origin,nonce) SELECT $1,$2,$3,$4,w.playback_id,w.youtube_id,$6,$7 FROM channel_watch_sessions w WHERE w.room_id=$4 AND w.playback_id=$5 AND w.source_kind='youtube' AND can_access_room(w.room_id,$2) AND room_has_permission(w.room_id,$2,'join_voice') AND EXISTS(SELECT 1 FROM channel_watch_viewers v WHERE v.room_id=w.room_id AND v.user_id=$2 AND v.seen_at>clock_timestamp()-interval '60 seconds')`, hash[:], user.ID, session.ID, room, in.PlaybackID, in.ParentOrigin, in.Nonce)
	if err == nil && tag.RowsAffected() == 0 {
		err = ErrForbidden
	}
	if err != nil {
		a.result(w, nil, err)
		return
	}
	_, _ = s.DB.Exec(r.Context(), `DELETE FROM youtube_player_tickets WHERE expires_at<clock_timestamp()`)
	a.json(w, 200, map[string]string{"ticket": ticket, "player_origin": a.Config.YouTubePlayerOrigin, "nonce": in.Nonce})
}

// WithYouTubePlayerHandler is outside application middleware by design. This
// hostname never resolves authentication, serves the SPA, or forwards cookies.
func (a *API) WithYouTubePlayerHandler(application http.Handler) http.Handler {
	origin, err := url.Parse(a.Config.YouTubePlayerOrigin)
	configured := err == nil && origin.Host != "" && ValidateYouTubePlayerOrigin(a.Config.YouTubePlayerOrigin, a.Config.AppURL) == nil
	var configuredHostname, configuredPort string
	if configured {
		configuredHostname, configuredPort, configured = playerAuthority(origin.Host)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostname, port, valid := playerAuthority(r.Host)
		if !valid {
			w.Header().Set("Cache-Control", "no-store")
			http.NotFound(w, r)
			return
		}
		reserved := hostname == productionPlayerHostname
		enabled := configured && strings.EqualFold(r.Host, origin.Host)
		if reserved && configuredHostname == productionPlayerHostname {
			defaultPort := "443"
			if origin.Scheme == "http" {
				defaultPort = "80"
			}
			if configuredPort == "" || configuredPort == defaultPort {
				enabled = port == "" || port == defaultPort
			}
		}
		if !reserved && !enabled {
			application.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), display-capture=(), geolocation=()")
		if !enabled {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'")
			if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
				a.json(w, http.StatusOK, map[string]string{"status": "disabled"})
			} else {
				http.NotFound(w, r)
			}
			return
		}
		app, _ := url.Parse(a.Config.AppURL)
		ancestors := "'none'"
		if app != nil && app.Host != "" {
			ancestors = app.Scheme + "://" + app.Host + " http://wails.localhost https://wails.localhost wails://wails"
		}
		// The opaque native parent is ticket-checked by the bridge; frame-ancestors
		// cannot name opaque origins. Do not expose API or credentials on this host.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; img-src https://i.ytimg.com data:; frame-ancestors "+ancestors)
		if r.URL.Path == "/player" && r.URL.Query().Get("opaque") == "1" {
			w.Header().Set("Content-Security-Policy", strings.Split(w.Header().Get("Content-Security-Policy"), "; frame-ancestors")[0])
		}
		switch {
		case r.URL.Path == "/healthz" && r.Method == http.MethodGet:
			a.json(w, 200, map[string]string{"status": "ok"})
		case r.URL.Path == "/player" && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(playerHTML))
		case r.URL.Path == "/player.js" && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			parents, _ := json.Marshal([]string{app.Scheme + "://" + app.Host, "http://wails.localhost", "https://wails.localhost", "wails://wails", "null"})
			_, _ = w.Write(append([]byte("const allowedParents="+string(parents)+";\n"), []byte(playerJavaScript)...))
		case r.URL.Path == "/claim" && r.Method == http.MethodPost:
			if !a.limiter.allow("youtube-bootstrap:"+remoteIP(r), 100, time.Minute) {
				a.fail(w, 429, "rate_limited", "Too many player attempts")
				return
			}
			a.claimYouTubePlayer(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}
func (a *API) claimYouTubePlayer(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" && origin != a.Config.YouTubePlayerOrigin {
		a.fail(w, 403, "invalid_player", "Invalid player origin")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var in struct {
		Ticket       string `json:"ticket"`
		Nonce        string `json:"nonce"`
		ParentOrigin string `json:"parent_origin"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil || len(in.Ticket) != 43 || !playerNoncePattern.MatchString(in.Nonce) || !playerParentAllowed(in.ParentOrigin, a.Config.AppURL) {
		a.fail(w, 400, "invalid_player", "Invalid player bootstrap")
		return
	}
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "Player unavailable")
		return
	}
	a.accessMu.RLock()
	defer a.accessMu.RUnlock()
	hash := sha256.Sum256([]byte(in.Ticket))
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	defer tx.Rollback(ctx)
	var video string
	err = tx.QueryRow(ctx, `DELETE FROM youtube_player_tickets t WHERE ticket_hash=$1 AND nonce=$2 AND parent_origin=$3 AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=t.session_id AND s.user_id=t.user_id AND s.expires_at>clock_timestamp()) AND can_access_room(t.room_id,t.user_id) AND room_has_permission(t.room_id,t.user_id,'join_voice') AND EXISTS(SELECT 1 FROM channel_watch_sessions w WHERE w.room_id=t.room_id AND w.playback_id=t.playback_id AND w.youtube_id=t.youtube_id AND w.source_kind='youtube') RETURNING youtube_id`, hash[:], in.Nonce, in.ParentOrigin).Scan(&video)
	if errors.Is(err, pgx.ErrNoRows) {
		a.fail(w, 403, "invalid_player", "Player ticket expired or no longer authorized")
		return
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		a.result(w, nil, err)
		return
	}
	a.json(w, 200, map[string]string{"video_id": video, "nonce": in.Nonce, "parent_origin": in.ParentOrigin})
}

const playerHTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BetterComms YouTube player</title><style>html,body{margin:0;width:100%;height:100%;min-height:200px;background:#000;color:white}#player,iframe{border:0;width:100%;height:100%;min-height:200px}</style><script defer src="/player.js"></script></head><body><div id="player"></div></body></html>`
const playerJavaScript = `"use strict";
let port,nonce,player,timer,script,claimRequest,booted=false,ready=false,disposed=false,applyingUntil=0;
const send=(type,value={})=>port?.postMessage({type,nonce,...value});
function cleanup(){disposed=true;ready=false;claimRequest?.abort();clearInterval(timer);script?.remove?.();try{player?.destroy()}catch{}player=undefined;port?.close();port=undefined;window.onYouTubeIframeAPIReady=undefined;window.removeEventListener('message',bootstrap)}
function bounded(v,min,max){return typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max}
function command(event){const v=event.data;if(disposed||!v||v.nonce!==nonce||v.type!=='playback'||!ready)return;
 if(Object.keys(v).some(k=>!['type','nonce','position','paused','enabled','volume','muted','force','revision'].includes(k))||!bounded(v.position,0,604800)||!bounded(v.volume,0,1)||typeof v.paused!=='boolean'||typeof v.enabled!=='boolean'||typeof v.muted!=='boolean')return;
 player.setVolume(v.volume*100);v.muted?player.mute():player.unMute();
 if(v.force||Math.abs(player.getCurrentTime()-v.position)>1.5){applyingUntil=performance.now()+1200;player.seekTo(v.position,true)}
 if(!v.enabled||v.paused){if(player.getPlayerState()===1){applyingUntil=performance.now()+1200;player.pauseVideo()}}else if(player.getPlayerState()!==1&&player.getPlayerState()!==3){applyingUntil=performance.now()+1200;player.playVideo()}
}
async function bootstrap(event){const v=event.data;
 if(disposed||booted||event.source!==window.parent||!allowedParents.includes(event.origin)||!v||v.type!=='bootstrap'||typeof v.ticket!=='string'||v.ticket.length!==43||typeof v.nonce!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(v.nonce)||event.ports.length!==1||Object.keys(v).some(k=>!['type','ticket','nonce'].includes(k)))return;
 booted=true;nonce=v.nonce;port=event.ports[0];port.onmessage=command;port.start();
 try{claimRequest=new AbortController();const response=await fetch('/claim',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:v.ticket,nonce,parent_origin:event.origin}),signal:claimRequest.signal});if(disposed)return;if(!response.ok)throw Error('Player ticket expired. Reopen the player.');const data=await response.json();if(disposed)return;if(data.nonce!==nonce||data.parent_origin!==event.origin||!/^[A-Za-z0-9_-]{11}$/.test(data.video_id))throw Error('Invalid player response');
 window.onYouTubeIframeAPIReady=()=>{if(disposed)return;player=new YT.Player('player',{host:'https://www.youtube-nocookie.com',width:'100%',height:'100%',videoId:data.video_id,playerVars:{origin:location.origin,playsinline:1,controls:1,autoplay:0},events:{onReady:()=>{if(disposed)return;ready=true;send('ready');timer=setInterval(()=>{if(!disposed&&player)send('position',{position:player.getCurrentTime(),duration:player.getDuration(),state:player.getPlayerState()})},500)},onStateChange:e=>{if(disposed)return;if(e.data===0)send('ended');else if(e.data===3)send('buffering');else if(performance.now()>applyingUntil&&(e.data===1||e.data===2))send('user-state',{paused:e.data===2,position:player.getCurrentTime()})},onError:e=>{if(!disposed)send('error',{code:e.data})},onAutoplayBlocked:()=>{if(!disposed)send('autoplay-blocked')}}})};
 script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{if(!disposed)send('error',{code:153})};document.head.append(script);
 }catch(error){if(!disposed)send('bootstrap-error',{message:error instanceof Error?error.message:'Player could not start'});cleanup()}
}
window.addEventListener('message',bootstrap);window.addEventListener('pagehide',cleanup,{once:true});
`
