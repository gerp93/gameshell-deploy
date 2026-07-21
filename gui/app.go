package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"gameshell-deploy-gui/deployconf"
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

// LoadSettings returns the persisted operator preferences (ops dir, last
// game repo dir). Never contains secrets.
func (a *App) LoadSettings() (settings.Settings, error) {
	return settings.Load()
}

// SelectOpsDir opens a directory picker and, if the chosen directory looks
// like a gameshell-deploy checkout, persists it as the ops dir.
func (a *App) SelectOpsDir() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select your gameshell-deploy checkout",
	})
	if err != nil || dir == "" {
		return "", err
	}
	if err := validateOpsDir(dir); err != nil {
		return "", err
	}
	s, err := settings.Load()
	if err != nil {
		return "", err
	}
	s.OpsDir = dir
	if err := settings.Save(s); err != nil {
		return "", err
	}
	return dir, nil
}

func validateOpsDir(dir string) error {
	required := []string{
		"create.sh",
		"delete.sh",
		filepath.Join("templates", "setup.sh"),
		filepath.Join("templates", "spec.yaml"),
		filepath.Join("examples", "deploy.conf"),
	}
	for _, rel := range required {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			return fmt.Errorf("%s not found under %s — is this a gameshell-deploy checkout?", rel, dir)
		}
	}
	return nil
}

// SelectGameRepoDir opens a directory picker for the game repo checkout and
// remembers it for next time.
func (a *App) SelectGameRepoDir() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select the game repo checkout",
	})
	if err != nil || dir == "" {
		return "", err
	}
	s, err := settings.Load()
	if err != nil {
		return "", err
	}
	s.LastGameRepoDir = dir
	if err := settings.Save(s); err != nil {
		return "", err
	}
	return dir, nil
}

// HasBackups reports whether gameRepoDir/backups contains at least one
// *.gpg file, mirroring create.sh's own check — surfaced earlier in the UI
// instead of failing deep into a run.
func (a *App) HasBackups(gameRepoDir string) (bool, error) {
	matches, err := filepath.Glob(filepath.Join(gameRepoDir, "backups", "*.gpg"))
	if err != nil {
		return false, err
	}
	return len(matches) > 0, nil
}

// --- deploy.conf editor ---------------------------------------------------

// DeployConfResult wraps DeployConf with a Found flag so the frontend can
// distinguish "no deploy.conf yet" from a zero-valued one.
type DeployConfResult struct {
	Found bool                  `json:"found"`
	Conf  deployconf.DeployConf `json:"conf"`
}

func (a *App) LoadDeployConf(gameRepoDir string) (DeployConfResult, error) {
	path := filepath.Join(gameRepoDir, "deploy.conf")
	if !deployconf.Exists(path) {
		return DeployConfResult{Found: false}, nil
	}
	conf, err := deployconf.Load(path)
	if err != nil {
		return DeployConfResult{}, err
	}
	return DeployConfResult{Found: true, Conf: conf}, nil
}

// CreateDeployConf copies OpsDir/examples/deploy.conf into gameRepoDir and
// applies conf's values on top of it.
func (a *App) CreateDeployConf(opsDir, gameRepoDir string, conf deployconf.DeployConf) error {
	if errs := deployconf.Validate(conf); len(errs) > 0 {
		return fmt.Errorf("invalid deploy.conf: %v", errs)
	}
	templatePath := filepath.Join(opsDir, "examples", "deploy.conf")
	destPath := filepath.Join(gameRepoDir, "deploy.conf")
	if err := deployconf.CreateFromTemplate(templatePath, destPath); err != nil {
		return err
	}
	return deployconf.Save(destPath, conf)
}

func (a *App) SaveDeployConf(gameRepoDir string, conf deployconf.DeployConf) error {
	if errs := deployconf.Validate(conf); len(errs) > 0 {
		return fmt.Errorf("invalid deploy.conf: %v", errs)
	}
	return deployconf.Save(filepath.Join(gameRepoDir, "deploy.conf"), conf)
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

// CancelRun kills the currently running script, if any. It does not clean
// up any cloud resources already created — the same caveat as Ctrl-C
// during CLI use.
func (a *App) CancelRun() bool {
	return scriptrunner.Cancel()
}
