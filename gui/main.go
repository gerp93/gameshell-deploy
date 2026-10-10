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
// CheckForUpdate/ApplyUpdate in app.go). Stamped at build time by
// KVG_Standards' release-go-gui.yml via `-X main.appVersion=vX.Y.Z`.
//
// A build that skips that workflow (a local `wails build`) keeps this
// zero value, which parses as 0.0.0 — lower than any real release tag, so
// CheckForUpdate will always report an update as available, even when
// already current. That's the opposite of "always up to date": it used to
// mean every "Check for Update" click re-applied the latest release,
// whether or not anything had actually changed.
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
