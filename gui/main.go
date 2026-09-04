package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// appVersion identifies this build for kvgupdate's update check (see
// CheckForUpdate/ApplyUpdate in app.go). Overridden at build time via
// `-ldflags "-X main.appVersion=vX.Y.Z"`.
//
// release-go-gui.yml stamps this when the caller passes
// version_ldflag_package: main (see auto-release.yml / cut-release.yml).
var appVersion = "0.0.0-dev"

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "gameshell-deploy",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
