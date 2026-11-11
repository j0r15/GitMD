// Package web embeds the static frontend (HTML, CSS, JS, and vendored
// editor/preview libraries) so the server ships as a single binary.
package web

import "embed"

//go:embed index.html static
var FS embed.FS
