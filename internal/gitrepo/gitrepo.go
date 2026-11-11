// Package gitrepo manages local working clones of configured git
// repositories and performs the pull/commit/push cycle behind each save.
package gitrepo

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gitmd/internal/config"
)

var ErrConflict = errors.New("push rejected: remote has new commits that could not be merged, reload and retry")
var ErrNotHugo = errors.New("repo is not configured with type: hugo")

type FileInfo struct {
	Path string `json:"path"` // slash-separated, relative to repo root
	Dir  bool   `json:"dir"`
}

type Repo struct {
	cfg     config.RepoConfig
	workdir string
	// buildDir holds the hugo-generated static site for repos with
	// type: hugo. It's a sibling of workdir, not inside it, so hugo's
	// output never interacts with git status/clean on the source clone.
	buildDir string
	// contentDir caches the repo's resolved hugo contentDir (default
	// "content", but sites can override it, e.g. to "docs") so the UI can
	// map an edited file's path to the URL it renders at. Detected once
	// via `hugo config` and assumed stable for the process lifetime.
	contentDir string
	mu         sync.Mutex
}

type Manager struct {
	repos map[string]*Repo
	order []string
}

func NewManager(cfg *config.Config) (*Manager, error) {
	m := &Manager{repos: map[string]*Repo{}}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating data dir: %w", err)
	}
	// Absolute, so git commands run with a different cmd.Dir (e.g. the
	// clone, which runs from the parent dir) still resolve the same path.
	dataDir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("resolving data dir: %w", err)
	}
	for _, rc := range cfg.Repos {
		r := &Repo{
			cfg:      rc,
			workdir:  filepath.Join(dataDir, rc.ID),
			buildDir: filepath.Join(dataDir, rc.ID+"-site"),
		}
		if err := r.ensureClone(); err != nil {
			return nil, fmt.Errorf("repo %q: %w", rc.ID, err)
		}
		m.repos[rc.ID] = r
		m.order = append(m.order, rc.ID)
	}
	return m, nil
}

type RepoSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Branch string `json:"branch"`
	Type   string `json:"type"`
}

func (m *Manager) List() []RepoSummary {
	out := make([]RepoSummary, 0, len(m.order))
	for _, id := range m.order {
		cfg := m.repos[id].cfg
		out = append(out, RepoSummary{ID: id, Name: cfg.Name, Branch: cfg.Branch, Type: cfg.Type})
	}
	return out
}

func (m *Manager) Get(id string) (*Repo, bool) {
	r, ok := m.repos[id]
	return r, ok
}

// --- git plumbing ---

func (r *Repo) authEnv() []string {
	cred := r.cfg.Username + ":" + r.cfg.Token
	header := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(cred))
	return []string{
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.extraHeader",
		"GIT_CONFIG_VALUE_0=" + header,
		"GIT_TERMINAL_PROMPT=0",
	}
}

func (r *Repo) run(dir string, args ...string) (string, error) {
	return runCmd(dir, "git", r.authEnv(), args...)
}

func runCmd(dir, name string, extraEnv []string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), extraEnv...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, out.String())
	}
	return out.String(), nil
}

// ensureClone clones the repo on first start; on later starts it reuses the
// existing clone and brings it up to date with the remote branch.
func (r *Repo) ensureClone() error {
	if _, err := os.Stat(filepath.Join(r.workdir, ".git")); err == nil {
		return r.sync()
	}
	if err := os.MkdirAll(filepath.Dir(r.workdir), 0o755); err != nil {
		return err
	}
	parent := filepath.Dir(r.workdir)
	_, err := r.run(parent, "clone", "--branch", r.cfg.Branch, "--single-branch", r.cfg.URL, r.workdir)
	return err
}

// fetchBranch fetches the configured branch and force-updates the local
// origin/<branch> tracking ref explicitly. A plain `git fetch origin
// <branch>` is not enough: the clone that created this working dir may
// have been made with --single-branch for a *different* branch (e.g. the
// config's branch was changed after the clone already existed on a
// persisted volume), in which case remote.origin.fetch is restricted to
// that other branch and a same-named fetch only updates FETCH_HEAD,
// leaving origin/<branch> undefined. Passing the full refspec on the
// command line bypasses that restriction and always creates/updates it.
func (r *Repo) fetchBranch() error {
	refspec := "+refs/heads/" + r.cfg.Branch + ":refs/remotes/origin/" + r.cfg.Branch
	_, err := r.run(r.workdir, "fetch", "origin", refspec)
	return err
}

// sync fetches the configured branch and hard-resets the working tree to
// it, discarding any stray local state so every edit starts from a clean,
// up-to-date base.
func (r *Repo) sync() error {
	if err := r.fetchBranch(); err != nil {
		return err
	}
	if _, err := r.run(r.workdir, "reset", "--hard", "origin/"+r.cfg.Branch); err != nil {
		return err
	}
	_, err := r.run(r.workdir, "clean", "-fd")
	return err
}

// --- path safety ---

// resolvePath validates a user-supplied, slash-separated repo-relative path
// and returns its absolute location on disk. It rejects anything that
// escapes the repo root or does not look like a markdown document.
func (r *Repo) resolvePath(relPath string, mustBeMarkdown bool) (string, error) {
	if relPath == "" || strings.HasPrefix(relPath, "/") {
		return "", fmt.Errorf("invalid path")
	}
	clean := filepath.Clean(relPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || filepath.IsAbs(clean) {
		return "", fmt.Errorf("invalid path")
	}
	for _, part := range strings.Split(clean, string(filepath.Separator)) {
		if part == ".." || part == ".git" {
			return "", fmt.Errorf("invalid path")
		}
	}
	if mustBeMarkdown {
		lower := strings.ToLower(clean)
		if !strings.HasSuffix(lower, ".md") && !strings.HasSuffix(lower, ".markdown") {
			return "", fmt.Errorf("only markdown files (.md/.markdown) are supported")
		}
	}
	abs := filepath.Join(r.workdir, clean)
	root := filepath.Clean(r.workdir) + string(filepath.Separator)
	if !strings.HasPrefix(abs+string(filepath.Separator), root) && abs != filepath.Clean(r.workdir) {
		return "", fmt.Errorf("invalid path")
	}
	return abs, nil
}

// --- public operations ---

func (r *Repo) Tree() ([]FileInfo, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return nil, err
	}

	var out []FileInfo
	err := filepath.WalkDir(r.workdir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(r.workdir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		lower := strings.ToLower(d.Name())
		if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") {
			out = append(out, FileInfo{Path: filepath.ToSlash(rel), Dir: false})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (r *Repo) ReadFile(relPath string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return "", err
	}
	abs, err := r.resolvePath(relPath, true)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// --- hugo preview ---

func (r *Repo) Type() string { return r.cfg.Type }

// BuildDir is where the hugo-built static site lives for repos with
// type: hugo. Empty for other repos.
func (r *Repo) BuildDir() string { return r.buildDir }

// BuildSite syncs to the latest commit, optionally overlays an unsaved
// edit on top of it, and runs `hugo` to regenerate the static site into
// buildDir, so it can be served as a live preview of what the repo's
// content actually renders as. baseURL is passed straight to hugo so
// internal links in the generated pages resolve correctly when served
// back out from under whatever path/host the preview is reached at.
//
// previewPath/previewContent let the caller preview an in-progress edit
// that hasn't been saved yet: the file is written into the synced
// working tree (never committed) right before the build. The next sync
// (on the next Tree/ReadFile/WriteFile/BuildSite call) resets it away via
// `reset --hard` + `clean -fd`, the same as any other untracked change,
// so it can never accidentally end up in a commit. Pass "" to just
// preview the last saved/committed content.
//
// Returns the repo's resolved hugo contentDir (e.g. "content", or "docs"
// if the site overrides it), so the caller can map a file's repo path to
// the URL it renders at without having to guess or hardcode "content/".
func (r *Repo) BuildSite(baseURL, previewPath, previewContent string) (string, error) {
	if r.cfg.Type != "hugo" {
		return "", ErrNotHugo
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return "", err
	}
	if previewPath != "" {
		abs, err := r.resolvePath(previewPath, true)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(abs, []byte(previewContent), 0o644); err != nil {
			return "", err
		}
	}
	contentDir := r.detectContentDir()
	// Deliberately not --quiet: on failure runCmd surfaces this output
	// back to the UI, and --quiet suppresses hugo's own ERROR lines too,
	// leaving just a bare "exit status 1" with no indication of why.
	_, err := runCmd(r.workdir, "hugo", nil,
		"--destination", r.buildDir,
		"--baseURL", baseURL,
		"--cleanDestinationDir",
	)
	return contentDir, err
}

// detectContentDir asks hugo for the site's fully resolved config and
// reads contentDir back out of it, so a site that overrides the default
// ("content") is still mapped correctly. Caches the result — a site's
// contentDir isn't something that changes at runtime — and falls back to
// the default on any failure rather than erroring the whole build out
// over what's just a UI nicety.
func (r *Repo) detectContentDir() string {
	if r.contentDir != "" {
		return r.contentDir
	}
	r.contentDir = "content"
	out, err := runCmd(r.workdir, "hugo", nil, "config", "--format", "json")
	if err != nil {
		return r.contentDir
	}
	var parsed struct {
		ContentDir string `json:"contentdir"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || parsed.ContentDir == "" {
		return r.contentDir
	}
	r.contentDir = parsed.ContentDir
	return r.contentDir
}

// commitAndPush stages relPath (or removal), commits, and pushes, retrying
// once after a fetch+rebase if the push was rejected as non-fast-forward.
func (r *Repo) commitAndPush(message string) error {
	status, err := r.run(r.workdir, "status", "--porcelain")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) == "" {
		return nil // nothing changed
	}

	authorName := r.cfg.CommitName
	authorEmail := r.cfg.CommitEmail
	if _, err := r.run(r.workdir, "-c", "user.name="+authorName, "-c", "user.email="+authorEmail,
		"commit", "-m", message); err != nil {
		return err
	}

	_, pushErr := r.run(r.workdir, "push", "origin", "HEAD:"+r.cfg.Branch)
	if pushErr == nil {
		return nil
	}

	// Retry once: fetch + rebase our single new commit onto the latest remote tip.
	if err := r.fetchBranch(); err != nil {
		r.abortAndReset()
		return pushErr
	}
	if _, err := r.run(r.workdir, "rebase", "origin/"+r.cfg.Branch); err != nil {
		r.run(r.workdir, "rebase", "--abort")
		r.abortAndReset()
		return ErrConflict
	}
	if _, err := r.run(r.workdir, "push", "origin", "HEAD:"+r.cfg.Branch); err != nil {
		r.abortAndReset()
		return ErrConflict
	}
	return nil
}

func (r *Repo) abortAndReset() {
	r.run(r.workdir, "reset", "--hard", "origin/"+r.cfg.Branch)
	r.run(r.workdir, "clean", "-fd")
}

func (r *Repo) WriteFile(relPath, content, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return err
	}
	abs, err := r.resolvePath(relPath, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return err
	}
	if _, err := r.run(r.workdir, "add", "--", relPath); err != nil {
		return err
	}
	if message == "" {
		message = "Update " + relPath
	}
	return r.commitAndPush(message)
}

func (r *Repo) DeleteFile(relPath, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return err
	}
	if _, err := r.resolvePath(relPath, true); err != nil {
		return err
	}
	if _, err := r.run(r.workdir, "rm", "--", relPath); err != nil {
		return err
	}
	if message == "" {
		message = "Delete " + relPath
	}
	return r.commitAndPush(message)
}

func (r *Repo) RenameFile(fromPath, toPath, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.sync(); err != nil {
		return err
	}
	if _, err := r.resolvePath(fromPath, true); err != nil {
		return err
	}
	toAbs, err := r.resolvePath(toPath, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		return err
	}
	if _, err := r.run(r.workdir, "mv", "--", fromPath, toPath); err != nil {
		return err
	}
	if message == "" {
		message = fmt.Sprintf("Rename %s to %s", fromPath, toPath)
	}
	return r.commitAndPush(message)
}
