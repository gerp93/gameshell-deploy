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
// `-X main.appVersion=vX.Y.Z`.
//
// KVG_Standards' release-go-gui.yml does not currently pass that ldflag —
// unlike release-python-gui.yml's `version_file` input, there's no
// mechanism yet for it to stamp a version into the compiled Go binary. A
// build produced by that workflow today still reports "0.0.0-dev" here, so
// CheckForUpdate always looks "up to date" until KVG_Standards is updated to
// inject this (a shared-workflow change, not something fixable from this
// repo alone — see gerp93/KVG_Standards).
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
