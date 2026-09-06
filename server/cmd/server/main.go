package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"bettercomms/server/internal/api"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	loadEnv("../.env")
	loadEnv(".env")
	dbURL := must("DATABASE_URL")
	pool, e := pgxpool.New(context.Background(), dbURL)
	if e != nil {
		log.Fatal(e)
	}
	defer pool.Close()
	if e = pool.Ping(context.Background()); e != nil {
		log.Fatal(e)
	}
	if e = runMigrations(context.Background(), pool, findMigrationsDir()); e != nil {
		log.Fatal(e)
	}
	cfg := api.Config{AppURL: get("APP_URL", "http://localhost:5173"), WorkOSClientID: os.Getenv("WORKOS_CLIENT_ID"), WorkOSAPIKey: os.Getenv("WORKOS_API_KEY"), WorkOSRedirectURI: get("WORKOS_REDIRECT_URI", "http://localhost:5173/api/v1/auth/callback"), DevAuth: get("DEV_AUTH", "false") == "true", ICEURLs: split(get("ICE_URLS", "stun:stun.l.google.com:19302")), TURNURLs: split(os.Getenv("TURN_URLS")), TURNSecret: os.Getenv("TURN_SECRET"), WebDist: os.Getenv("WEB_DIST")}
	store := &api.PostgresStore{DB: pool}
	a := api.New(store, api.Sessions{Store: store, Secure: get("COOKIE_SECURE", "false") == "true"}, cfg)
	srv := &http.Server{Addr: get("HTTP_ADDR", ":8080"), Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		log.Printf("Bettercomms API listening on %s", srv.Addr)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Fatalf("server: %v", e)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if e := srv.Shutdown(ctx); e != nil {
		log.Printf("graceful shutdown: %v", e)
	}
}

type migrationDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func findMigrationsDir() string {
	if v := os.Getenv("MIGRATIONS_DIR"); v != "" {
		return v
	}
	for _, p := range []string{"migrations", filepath.Join("server", "migrations")} {
		if info, e := os.Stat(p); e == nil && info.IsDir() {
			return p
		}
	}
	return "migrations"
}
func runMigrations(ctx context.Context, db migrationDB, dir string) error {
	files, e := filepath.Glob(filepath.Join(dir, "*.sql"))
	if e != nil {
		return e
	}
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("no migrations found in %s", dir)
	}
	for _, path := range files {
		sql, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		if _, e = db.Exec(ctx, string(sql)); e != nil {
			return fmt.Errorf("migration %s: %w", filepath.Base(path), e)
		}
	}
	return nil
}
func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}
func get(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func split(v string) []string {
	out := []string{}
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}
func loadEnv(path string) {
	f, e := os.Open(path)
	if e != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		p := strings.SplitN(line, "=", 2)
		if len(p) == 2 && os.Getenv(strings.TrimSpace(p[0])) == "" {
			os.Setenv(strings.TrimSpace(p[0]), strings.Trim(strings.TrimSpace(p[1]), `"'`))
		}
	}
}
