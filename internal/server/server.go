package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"

	"gitmd/internal/config"
	"gitmd/internal/gitrepo"
	"gitmd/web"
)

type Server struct {
	cfg           *config.Config
	manager       *gitrepo.Manager
	authPassword  string
	sessionSecret []byte
	mux           *http.ServeMux
}

func New(cfg *config.Config, manager *gitrepo.Manager) (*Server, error) {
	s := &Server{
		cfg:           cfg,
		manager:       manager,
		authPassword:  cfg.AuthPassword,
		sessionSecret: []byte(cfg.SessionSecret),
		mux:           http.NewServeMux(),
	}
	s.routes()
	return s, nil
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("POST /api/login", s.handleLogin)
	s.mux.HandleFunc("POST /api/logout", s.handleLogout)

	s.mux.HandleFunc("GET /api/repos", s.requireAuth(s.handleListRepos))
	s.mux.HandleFunc("GET /api/repos/{id}/tree", s.requireAuth(s.handleTree))
	s.mux.HandleFunc("GET /api/repos/{id}/file", s.requireAuth(s.handleGetFile))
	s.mux.HandleFunc("PUT /api/repos/{id}/file", s.requireAuth(s.handlePutFile))
	s.mux.HandleFunc("DELETE /api/repos/{id}/file", s.requireAuth(s.handleDeleteFile))
	s.mux.HandleFunc("POST /api/repos/{id}/rename", s.requireAuth(s.handleRenameFile))
	s.mux.HandleFunc("POST /api/repos/{id}/build", s.requireAuth(s.handleBuildSite))
	s.mux.HandleFunc("GET /preview/{id}/{rest...}", s.requireAuth(s.handlePreview))

	staticFS, err := fs.Sub(web.FS, "static")
	if err != nil {
		log.Fatalf("mounting static assets: %v", err)
	}
	s.mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	s.mux.HandleFunc("/", s.handleIndex)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	data, err := web.FS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

func (s *Server) repoFromRequest(w http.ResponseWriter, r *http.Request) (*gitrepo.Repo, bool) {
	id := r.PathValue("id")
	repo, ok := s.manager.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, fmt.Errorf("unknown repo %q", id))
		return nil, false
	}
	return repo, true
}

func (s *Server) handleListRepos(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.manager.List())
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	files, err := repo.Tree()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	content, err := repo.ReadFile(path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path, "content": content})
}

func (s *Server) handlePutFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Message string `json:"message"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := repo.WriteFile(body.Path, body.Content, body.Message); err != nil {
		writeRepoErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	message := r.URL.Query().Get("message")
	if err := repo.DeleteFile(path, message); err != nil {
		writeRepoErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRenameFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	var body struct {
		From    string `json:"from"`
		To      string `json:"to"`
		Message string `json:"message"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := repo.RenameFile(body.From, body.To, body.Message); err != nil {
		writeRepoErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleBuildSite regenerates the hugo-built static site for a type: hugo
// repo and reports the URL path it's now served from. baseURL is derived
// from the request itself so internal links in the generated pages resolve
// whether this instance is reached over http or https, on whatever host.
//
// The body optionally carries an unsaved edit (path + its current editor
// content) to preview before it's been committed — see BuildSite.
func (s *Server) handleBuildSite(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if repo.Type() != "hugo" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("repo %q is not configured with type: hugo", id))
		return
	}
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	previewPath := "/preview/" + id + "/"
	contentDir, err := repo.BuildSite(scheme+"://"+r.Host+previewPath, body.Path, body.Content)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"previewUrl": previewPath, "contentDir": contentDir})
}

// handlePreview serves the static site hugo built for a type: hugo repo.
// It 404s for anything else, including a hugo repo that hasn't been built
// yet (BuildDir won't exist), rather than exposing raw directory listings.
func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repoFromRequest(w, r)
	if !ok {
		return
	}
	if repo.Type() != "hugo" {
		http.NotFound(w, r)
		return
	}
	prefix := "/preview/" + r.PathValue("id") + "/"
	http.StripPrefix(prefix, http.FileServer(http.Dir(repo.BuildDir()))).ServeHTTP(w, r)
}

func writeRepoErr(w http.ResponseWriter, err error) {
	if errors.Is(err, gitrepo.ErrConflict) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	writeErr(w, http.StatusBadRequest, err)
}

func decodeJSON(r *http.Request, v any) error {
	defer io.Copy(io.Discard, r.Body)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
