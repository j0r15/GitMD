package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type RepoConfig struct {
	ID          string `yaml:"id"`
	Name        string `yaml:"name"`
	URL         string `yaml:"url"`
	Branch      string `yaml:"branch"`
	Username    string `yaml:"username"`
	Token       string `yaml:"token"`
	CommitName  string `yaml:"commit_name"`
	CommitEmail string `yaml:"commit_email"`
	// Type selects how the editor previews this repo's content: "plain"
	// (default) renders markdown with the built-in renderer, "hugo" builds
	// the repo with the hugo binary and previews the real site instead.
	Type string `yaml:"type"`
}

type Config struct {
	ListenAddr    string       `yaml:"listen_addr"`
	DataDir       string       `yaml:"data_dir"`
	AuthPassword  string       `yaml:"auth_password"`
	SessionSecret string       `yaml:"session_secret"`
	Repos         []RepoConfig `yaml:"repos"`
}

// Load reads the YAML config at path and expands ${VAR} / $VAR references
// against the process environment in every secret-bearing field, so tokens
// and passwords can be kept out of the config file on disk.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":8080"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}

	cfg.AuthPassword = os.ExpandEnv(cfg.AuthPassword)
	cfg.SessionSecret = os.ExpandEnv(cfg.SessionSecret)

	if cfg.AuthPassword == "" {
		return nil, fmt.Errorf("auth_password must be set")
	}
	if cfg.SessionSecret == "" {
		return nil, fmt.Errorf("session_secret must be set")
	}
	if len(cfg.Repos) == 0 {
		return nil, fmt.Errorf("at least one repo must be configured")
	}

	seen := map[string]bool{}
	for i := range cfg.Repos {
		r := &cfg.Repos[i]
		r.Token = os.ExpandEnv(r.Token)
		r.Username = os.ExpandEnv(r.Username)

		if r.ID == "" {
			return nil, fmt.Errorf("repo at index %d is missing an id", i)
		}
		if seen[r.ID] {
			return nil, fmt.Errorf("duplicate repo id %q", r.ID)
		}
		seen[r.ID] = true

		if r.Name == "" {
			r.Name = r.ID
		}
		if r.URL == "" {
			return nil, fmt.Errorf("repo %q is missing a url", r.ID)
		}
		if r.Branch == "" {
			r.Branch = "main"
		}
		if r.Username == "" {
			r.Username = "oauth2"
		}
		if r.Token == "" {
			return nil, fmt.Errorf("repo %q is missing a token", r.ID)
		}
		if r.CommitName == "" {
			r.CommitName = "gitmd"
		}
		if r.CommitEmail == "" {
			r.CommitEmail = "gitmd@localhost"
		}
		if r.Type == "" {
			r.Type = "plain"
		}
		if r.Type != "plain" && r.Type != "hugo" {
			return nil, fmt.Errorf("repo %q: type must be \"plain\" or \"hugo\", got %q", r.ID, r.Type)
		}
	}

	return &cfg, nil
}
