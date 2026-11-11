package main

import (
	"flag"
	"log"
	"net/http"

	"gitmd/internal/config"
	"gitmd/internal/gitrepo"
	"gitmd/internal/server"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	manager, err := gitrepo.NewManager(cfg)
	if err != nil {
		log.Fatalf("git setup: %v", err)
	}

	srv, err := server.New(cfg, manager)
	if err != nil {
		log.Fatalf("server: %v", err)
	}

	log.Printf("gitmd listening on %s", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, srv.Handler()); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}
