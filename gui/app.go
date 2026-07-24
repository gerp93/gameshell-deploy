package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"gameshell-deploy-gui/deployconf"
	"gameshell-deploy-gui/platform"
	"gameshell-deploy-gui/preflight"
	"gameshell-deploy-gui/scriptrunner"
	"gameshell-deploy-gui/settings"
)

// App is the Wails-bound backend. Its exported methods are callable from
// the frontend as window.go.main.App.<Method>.
type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// --- settings / ops repo / game repo -----------------------------------

// LoadSettings returns the persisted operator preferences (last app name).
// Never contains secrets.
func (a *App) LoadSettings() (settings.Settings, error) {
	return settings.Load()
}

// GetOpsDir locates the gameshell-deploy checkout this GUI is running from
// — it's always the checkout containing the running executable (gui is
// built and run from inside it, normally at gui/build/bin/), never a
// user-picked folder, since games/ is expected to live right alongside
// create.sh/delete.sh in the same checkout as the GUI itself.
func (a *App) GetOpsDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		if validateOpsDir(dir) == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("could not find a gameshell-deploy checkout (create.sh, delete.sh, templates/, deploy.conf.template) above %s", filepath.Dir(exe))
}

// OpenOpsDir opens opsDir in the host's file manager (Explorer/Finder), so
// the operator can inspect games/, backups/, etc. directly.
func (a *App) OpenOpsDir(opsDir string) error {
	return platform.OpenFolder(opsDir)
}

func validateOpsDir(dir string) error {
	required := []string{
		"create.sh",
		"delete.sh",
		filepath.Join("templates", "setup.sh"),
		filepath.Join("templates", "spec.yaml"),
		filepath.Join("deploy.conf.template"),
	}
	for _, rel := range required {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			return fmt.Errorf("%s not found under %s — is this a gameshell-deploy checkout?", rel, dir)
		}
	}
	return nil
}

// ListGames returns the app names under opsDir/games/ (each a subdirectory
// holding that game's deploy.conf and backups/), sorted alphabetically.
func (a *App) ListGames(opsDir string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(opsDir, "games"))
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// SelectApp remembers appName as the last-used app for next time.
func (a *App) SelectApp(appName string) error {
	s, err := settings.Load()
	if err != nil {
		return err
	}
	s.LastAppName = appName
	return settings.Save(s)
}

// SetTheme remembers the operator's chosen UI theme (a data-theme slug, or
// "" for the default) for next time.
func (a *App) SetTheme(theme string) error {
	s, err := settings.Load()
	if err != nil {
		return err
	}
	s.Theme = theme
	return settings.Save(s)
}

func gameConfigDir(opsDir, appName string) string {
	return filepath.Join(opsDir, "games", appName)
}

// HasBackups reports whether games/appName/backups contains at least one
// *.gpg file, mirroring create.sh's own check — surfaced earlier in the UI
// instead of failing deep into a run.
func (a *App) HasBackups(opsDir, appName string) (bool, error) {
	matches, err := filepath.Glob(filepath.Join(gameConfigDir(opsDir, appName), "backups", "*.gpg"))
	if err != nil {
		return false, err
	}
	return len(matches) > 0, nil
}

// OpenBackupsFolder opens games/appName/backups in the host's file manager,
// creating it first if it doesn't exist yet (e.g. a brand new game with no
// backups taken).
func (a *App) OpenBackupsFolder(opsDir, appName string) error {
	dir := filepath.Join(gameConfigDir(opsDir, appName), "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return platform.OpenFolder(dir)
}

// DeleteGame permanently removes games/appName — its deploy.conf and any
// locally stored backups — from disk. Refuses while Digital Ocean still
// reports a live droplet/app for it: deleting the local config first would
// destroy the only record of what still needs tearing down on DO.
func (a *App) DeleteGame(opsDir, appName string) error {
	confResult, err := a.LoadDeployConf(opsDir, appName)
	if err != nil {
		return err
	}
	if confResult.Found {
		status, err := scriptrunner.CheckStatus(confResult.Conf.AppName)
		if err != nil {
			return fmt.Errorf("could not verify Digital Ocean status before deleting: %w", err)
		}
		if status.DropletExists || status.AppExists {
			return fmt.Errorf("%s still has a droplet/app on Digital Ocean — tear it down first", appName)
		}
	}
	return os.RemoveAll(gameConfigDir(opsDir, appName))
}

// --- deploy.conf editor ---------------------------------------------------

// DeployConfResult wraps DeployConf with a Found flag so the frontend can
// distinguish "no deploy.conf yet" from a zero-valued one.
type DeployConfResult struct {
	Found bool                  `json:"found"`
	Conf  deployconf.DeployConf `json:"conf"`
}

func (a *App) LoadDeployConf(opsDir, appName string) (DeployConfResult, error) {
	path := filepath.Join(gameConfigDir(opsDir, appName), "deploy.conf")
	if !deployconf.Exists(path) {
		return DeployConfResult{Found: false}, nil
	}
	conf, err := deployconf.Load(path)
	if err != nil {
		return DeployConfResult{}, err
	}
	return DeployConfResult{Found: true, Conf: conf}, nil
}

// CreateDeployConf creates games/appName/ (and its backups/ subdirectory),
// copies OpsDir/deploy.conf.template into it, and applies conf's values on
// top of it.
func (a *App) CreateDeployConf(opsDir, appName string, conf deployconf.DeployConf) error {
	if errs := deployconf.Validate(conf); len(errs) > 0 {
		return fmt.Errorf("invalid deploy.conf: %v", errs)
	}
	configDir := gameConfigDir(opsDir, appName)
	if err := os.MkdirAll(filepath.Join(configDir, "backups"), 0o755); err != nil {
		return err
	}
	templatePath := filepath.Join(opsDir, "deploy.conf.template")
	destPath := filepath.Join(configDir, "deploy.conf")
	if err := deployconf.CreateFromTemplate(templatePath, destPath); err != nil {
		return err
	}
	return deployconf.Save(destPath, conf)
}

func (a *App) SaveDeployConf(opsDir, appName string, conf deployconf.DeployConf) error {
	if errs := deployconf.Validate(conf); len(errs) > 0 {
		return fmt.Errorf("invalid deploy.conf: %v", errs)
	}
	return deployconf.Save(filepath.Join(gameConfigDir(opsDir, appName), "deploy.conf"), conf)
}

// --- preflight -------------------------------------------------------------

func (a *App) RunPreflightChecks() preflight.Result {
	return preflight.RunChecks()
}

// --- deploy / teardown -----------------------------------------------------

// wailsEmitter adapts Wails' runtime.EventsEmit to scriptrunner.Emitter.
type wailsEmitter struct {
	ctx context.Context
}

func (e wailsEmitter) EmitLog(event string, line scriptrunner.LogLine) {
	runtime.EventsEmit(e.ctx, event, line)
}

func (e wailsEmitter) EmitExit(event string, info scriptrunner.ExitInfo) {
	runtime.EventsEmit(e.ctx, event, info)
}

func (a *App) ListSSHKeys() ([]string, error) {
	return scriptrunner.ListSSHKeys()
}

// ListAvailableTiers returns the price tiers create.sh reports as available
// in appName's configured region (deploy.conf's DROPLET_REGION), so the
// deploy panel only offers tiers that won't fail with a 422 at create time.
func (a *App) ListAvailableTiers(opsDir, appName string) ([]scriptrunner.TierOption, error) {
	return scriptrunner.ListAvailableTiers(opsDir, appName)
}

// CheckStatus reports whether appName (deploy.conf's APP_NAME) already has a
// droplet/app on Digital Ocean, so the frontend knows whether it's set up
// for a Deploy or a Teardown.
func (a *App) CheckStatus(appName string) (scriptrunner.StatusResult, error) {
	return scriptrunner.CheckStatus(appName)
}

// RunCreate starts create.sh in the background and returns immediately;
// progress and the final result arrive as "create:log" / "create:exit"
// events (see scriptrunner.RunCreate).
func (a *App) RunCreate(req scriptrunner.CreateRequest) {
	go func() {
		_ = scriptrunner.RunCreate(req, wailsEmitter{ctx: a.ctx})
	}()
}

// RunDelete starts delete.sh in the background and returns immediately;
// progress and the final result arrive as "delete:log" / "delete:exit"
// events (see scriptrunner.RunDelete).
func (a *App) RunDelete(req scriptrunner.DeleteRequest) {
	go func() {
		_ = scriptrunner.RunDelete(req, wailsEmitter{ctx: a.ctx})
	}()
}

// CancelRun kills the running script for appName, if any. It does not clean
// up any cloud resources already created — the same caveat as Ctrl-C
// during CLI use.
func (a *App) CancelRun(appName string) bool {
	return scriptrunner.Cancel(appName)
}
