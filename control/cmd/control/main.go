// Command control is the Fluxo v2 control-plane process.
//
// It is deliberately thin (docs/01-arquitectura.md): boot, expose health, and
// — in later phases — resolve tenants and dispatch to the runtime layer. State
// and isolation live in Postgres+RLS, not here.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aiudalabs/fluxo/control/internal/config"
	"github.com/aiudalabs/fluxo/control/internal/httpapi"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg := config.Load(os.LookupEnv)
	srv := httpapi.New(cfg.CORSOrigin)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if err := run(httpServer, log); err != nil {
		log.Error("control exited with error", "err", err)
		os.Exit(1)
	}
}

// run starts the HTTP server and blocks until an interrupt/terminate signal,
// then shuts down gracefully.
func run(httpServer *http.Server, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Info("control listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}
