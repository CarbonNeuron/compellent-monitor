package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func routes(m *Monitor) http.Handler {
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(value); err != nil {
			slog.Debug("response write failed", "error", err)
		}
	}
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, m.current.Load()) })
	mux.HandleFunc("GET /api/objects", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, m.current.Load().Objects) })
	mux.HandleFunc("GET /api/schema", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, m.schema) })
	mux.HandleFunc("GET /api/export", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="compellent-snapshot.json"`)
		s := m.current.Load()
		writeJSON(w, struct {
			*Snapshot
			Objects []Observation `json:"objects"`
		}{s, s.Objects})
	})
	// Readiness concerns the web service, not the monitored SAN. Target downtime
	// must leave the dashboard reachable to display its last good sample.
	for _, path := range []string{"/healthz", "/readyz"} {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprintln(w, "ok")
		})
	}
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		s := m.current.Load()
		up := 0
		if s.State == "ok" && time.Since(s.LastSuccess) < 2*m.cfg.PollInterval+m.cfg.PollTimeout {
			up = 1
		}
		fmt.Fprintf(w, "# HELP compellent_snmp_up Whether the latest Dell walk succeeded and is fresh.\n# TYPE compellent_snmp_up gauge\ncompellent_snmp_up %d\n", up)
		if !s.LastSuccess.IsZero() {
			fmt.Fprintf(w, "compellent_last_success_timestamp_seconds %d\n", s.LastSuccess.Unix())
		}
		fmt.Fprintf(w, "compellent_disks %d\ncompellent_healthy_disks %d\ncompellent_active_alert_entries %d\ncompellent_storage_total_bytes %.0f\ncompellent_storage_used_bytes %.0f\ncompellent_storage_free_bytes %.0f\n", s.Summary.Disks, s.Summary.HealthyDisks, s.Summary.ActiveAlerts, s.Summary.TotalGiB*(1<<30), s.Summary.UsedGiB*(1<<30), s.Summary.FreeGiB*(1<<30))
		if s.Summary.MaxTempC != nil {
			fmt.Fprintf(w, "compellent_max_temperature_celsius %g\n", *s.Summary.MaxTempC)
		}
	})
	web, _ := fs.Sub(assets, "web")
	mux.Handle("GET /", http.FileServer(http.FS(web)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func main() {
	c, err := loadConfig()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	schema, err := loadSchema()
	if err != nil {
		slog.Error("cannot load MIB schema", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	m := newMonitor(c, schema, snmpWalker(c))
	go m.run(ctx)
	server := &http.Server{Addr: c.Listen, Handler: routes(m), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("Compellent monitor listening", "address", c.Listen, "target", c.Target, "pollInterval", c.PollInterval)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP server failed", "error", err)
		os.Exit(1)
	}
}
