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
	"strconv"
	"strings"
	"syscall"
	"time"

	"bettercomms/server/internal/api"
	"github.com/aws/aws-sdk-go-v2/config"
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
	cfg := api.Config{AppURL: get("APP_URL", "http://localhost:5173"), WorkOSClientID: os.Getenv("WORKOS_CLIENT_ID"), WorkOSAPIKey: os.Getenv("WORKOS_API_KEY"), WorkOSRedirectURI: get("WORKOS_REDIRECT_URI", "http://localhost:5173/api/v1/auth/callback"), DevAuth: get("DEV_AUTH", "false") == "true", ICEURLs: split(get("ICE_URLS", "stun:stun.l.google.com:19302")), TURNURLs: split(os.Getenv("TURN_URLS")), TURNSecret: os.Getenv("TURN_SECRET"), WebDist: os.Getenv("WEB_DIST"), SFUURL: os.Getenv("SFU_URL"), SFUJoinSecret: os.Getenv("SFU_JOIN_SECRET"), VAPIDPublicKey: os.Getenv("VAPID_PUBLIC_KEY"), VAPIDPrivateKey: os.Getenv("VAPID_PRIVATE_KEY"), VAPIDSubject: os.Getenv("VAPID_SUBJECT")}
	cfg.AttachmentMaxBytes = api.DefaultAttachmentMaxBytes
	if value := os.Getenv("ATTACHMENT_MAX_BYTES"); value != "" {
		limit, parseErr := strconv.ParseInt(value, 10, 64)
		if parseErr != nil || limit < 1<<20 || limit > api.MaximumAttachmentMaxBytes {
			log.Fatal("ATTACHMENT_MAX_BYTES must be between 1048576 and 2147483648")
		}
		cfg.AttachmentMaxBytes = limit
	}
	if err := api.ValidVAPIDConfig(cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, cfg.VAPIDSubject); err != nil {
		log.Fatal(err)
	}
	store := &api.PostgresStore{DB: pool}
	a := api.New(store, api.Sessions{Store: store, Secure: get("COOKIE_SECURE", "false") == "true"}, cfg)
	storageFeatures, storageErr := api.StorageFeatureOptionsFromEnv()
	if storageErr != nil {
		log.Fatal(storageErr)
	}
	a.StorageFeatures = storageFeatures
	statusContext, stopStatus := context.WithCancel(context.Background())
	defer stopStatus()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			cleanupCtx, cancel := context.WithTimeout(statusContext, 10*time.Second)
			if err := a.ExpireCustomStatuses(cleanupCtx); err != nil && statusContext.Err() == nil {
				log.Printf("custom status cleanup failed: %v", err)
			}
			cancel()
			select {
			case <-statusContext.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	if cfg.VAPIDPublicKey != "" {
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				pushCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				if _, pushErr := store.DispatchPush(pushCtx, cfg); pushErr != nil {
					log.Printf("push delivery failed: %v", pushErr)
				}
				cancel()
				<-ticker.C
			}
		}()
	}
	if bucket := os.Getenv("AWS_S3_BUCKET"); bucket != "" {
		if os.Getenv("AWS_REGION") == "" {
			log.Fatal("AWS_REGION is required when AWS_S3_BUCKET is set")
		}
		awsConfig, loadErr := config.LoadDefaultConfig(context.Background())
		if loadErr != nil {
			log.Fatal("S3 configuration: ", loadErr)
		}
		a.Attachments = api.NewS3AttachmentStorage(awsConfig, bucket)
		go func() {
			ticker := time.NewTicker(time.Hour)
			defer ticker.Stop()
			for {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
				if cleanErr := store.CleanPendingAttachments(cleanupCtx, a.Attachments); cleanErr != nil {
					log.Printf("attachment cleanup failed: %v", cleanErr)
				}
				if cleanErr := a.CleanStorageFeatures(cleanupCtx); cleanErr != nil {
					log.Printf("storage policy cleanup failed: %v", cleanErr)
				}
				cancel()
				<-ticker.C
			}
		}()
	}
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
	stopStatus()
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
