package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/gerp93/KVG_Standards/packages/go/kvgupdate"

	"gameshell-deploy-gui/deployconf"
	"gameshell-deploy-gui/platform"
	"gameshell-deploy-gui/preflight"
	"gameshell-deploy-gui/scriptrunner"
	"gameshell-deploy-gui/secrets"
	"gameshell-deploy-gui/settings"
)

// updateRepo/updateAppName identify this app to kvgupdate — see
// CheckForUpdate/ApplyUpdate below and appVersion's doc comment in main.go
// for the current limitation on knowing our own running version.
const (
	updateRepo    = "gerp93/gameshell-deploy"
	updateAppName = "gameshell-deploy-gui"
)

// App is the Wails-bound backend. Its exported methods are callable from
// the frontend as window.go.main.App.<Method>.
type App struct {
	ctx       context.Context
	scriptDir string
	dataDir   string
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) resolveDirs() error {
	if a.dataDir != "" && a.scriptDir != "" {
		return nil
	}
	scriptDir, err := findScriptDir()
	if err != nil {
		return err
	}
	dataDir, err := operatorDataDir(scriptDir)
	if err != nil {
		return err
	}
	a.scriptDir = scriptDir
	a.dataDir = dataDir
	return nil
}

// GetAppVersion is the build-time stamp (`-X main.appVersion=vX.Y.Z`), or
// "0.0.0-dev" for local `wails dev` builds.
func (a *App) GetAppVersion() string {
	return appVersion
}

// --- settings / ops repo / game repo -----------------------------------

// LoadSettings returns the persisted operator preferences (last app name).
// Never contains secrets.
func (a *App) LoadSettings() (settings.Settings, error) {
	return settings.Load()
}

// GetOpsDir returns the writable DATA dir (games/ and backups/), not the
// script install dir. From a git checkout that's the repo (today's
// behavior). From an installed app it's UserConfigDir/gameshell-deploy
// (%APPDATA%\gameshell-deploy on Windows). Missing games are seeded from
// scriptDir/seed/games or scriptDir/games only when that game folder does
// not already exist and was not deleted or renamed away — never overwritten.
func (a *App) GetOpsDir() (string, error) {
	if err := a.resolveDirs(); err != nil {
		return "", err
	}
	return a.dataDir, nil
}

// OpenOpsDir opens the data dir in the host's file manager (Explorer/Finder),
// so the operator can inspect games/, backups/, etc. directly.
func (a *App) OpenOpsDir(opsDir string) error {
	if opsDir == "" {
		if err := a.resolveDirs(); err != nil {
			return err
		}
		opsDir = a.dataDir
	}
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

// SetRememberSecrets stores the opt-in to keep SQL/API/GPG secrets in the
// OS keyring. This flag is not a secret; the values themselves never land
// in settings.json.
func (a *App) SetRememberSecrets(remember bool) error {
	s, err := settings.Load()
	if err != nil {
		return err
	}
	s.RememberSecrets = remember
	return settings.Save(s)
}

// LoadSecrets fills SQL/GPG/extra values from the environment first (same
// names as the CLI), then from the OS keyring for anything still empty.
func (a *App) LoadSecrets(extraNames []string) (secrets.Bundle, error) {
	env := secrets.FromEnv(extraNames)
	stored, err := secrets.Load(extraNames)
	if err != nil {
		return env, nil
	}
	return secrets.Merge(env, stored), nil
}

// SaveSecrets writes non-empty fields to the OS keyring. Empty fields are
// left unchanged so a blank box doesn't wipe a previously saved value.
func (a *App) SaveSecrets(bundle secrets.Bundle) error {
	return secrets.Save(bundle)
}

// ForgetSecrets removes SQL/GPG secrets and the extra names listed.
func (a *App) ForgetSecrets(extraNames []string) error {
	return secrets.Forget(extraNames)
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

// RenameGame renames the games/oldName directory to games/newName, moving
// its deploy.conf and backups with it. This changes only the folder name the
// sidebar lists — deploy.conf's own APP_NAME (which names the Digital Ocean
// droplet/app) is edited separately in the Config tab, so this is safe to do
// without touching cloud resources. Still refuses while a droplet/app is
// live, since scripts are invoked by folder name and moving it mid-life
// makes the running deployment harder to find. On an installed app the old
// name is recorded so seedMissingGames will not recreate it on next launch.
func (a *App) RenameGame(opsDir, oldName, newName string) error {
	newName = strings.TrimSpace(newName)
	if newName == "" {
		return fmt.Errorf("new name cannot be empty")
	}
	// The name becomes a path segment under games/, so anything that could
	// escape that directory or confuse path joining is rejected outright
	// rather than sanitized into something the operator didn't ask for.
	if strings.ContainsAny(newName, `/\`) || newName == "." || newName == ".." {
		return fmt.Errorf("invalid game name: %s", newName)
	}
	if newName == oldName {
		return nil
	}

	confResult, err := a.LoadDeployConf(opsDir, oldName)
	if err != nil {
		return err
	}
	if confResult.Found {
		status, err := scriptrunner.CheckStatus(confResult.Conf.AppName)
		if err != nil {
			return fmt.Errorf("could not verify Digital Ocean status before renaming: %w", err)
		}
		if status.DropletExists || status.AppExists {
			return fmt.Errorf("%s still has a droplet/app on Digital Ocean — tear it down before renaming", oldName)
		}
	}

	newPath := gameConfigDir(opsDir, newName)
	if _, err := os.Stat(newPath); err == nil {
		return fmt.Errorf("a game named %s already exists", newName)
	}
	if err := rememberRemovedGame(opsDir, oldName); err != nil {
		return err
	}
	if err := os.Rename(gameConfigDir(opsDir, oldName), newPath); err != nil {
		return err
	}
	return forgetRemovedGame(opsDir, newName)
}

// DeleteGame permanently removes games/appName — its deploy.conf and any
// locally stored backups — from disk. Refuses while Digital Ocean still
// reports a live droplet/app for it: deleting the local config first would
// destroy the only record of what still needs tearing down on DO. On an
// installed app the name is recorded so the next launch will not recreate
// the folder from the package seed.
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
	if err := rememberRemovedGame(opsDir, appName); err != nil {
		return err
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
	if err := a.resolveDirs(); err != nil {
		return err
	}
	templatePath := filepath.Join(a.scriptDir, "deploy.conf.template")
	destPath := filepath.Join(configDir, "deploy.conf")
	if err := deployconf.CreateFromTemplate(templatePath, destPath); err != nil {
		return err
	}
	if err := deployconf.Save(destPath, conf); err != nil {
		return err
	}
	return forgetRemovedGame(opsDir, appName)
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
// in appName's region, so the deploy panel only offers tiers that won't fail
// with a 422 at create time. region is optional — empty uses deploy.conf's
// DROPLET_REGION, anything else checks that region instead.
func (a *App) ListAvailableTiers(opsDir, appName, region string) ([]scriptrunner.TierOption, error) {
	if err := a.resolveDirs(); err != nil {
		return nil, err
	}
	dataDir := opsDir
	if dataDir == "" {
		dataDir = a.dataDir
	}
	return scriptrunner.ListAvailableTiers(a.scriptDir, dataDir, appName, region)
}

// ListAvailableRegions returns the regions offering at least one price tier,
// for the deploy panel's region override dropdown.
func (a *App) ListAvailableRegions(opsDir, appName string) ([]scriptrunner.RegionOption, error) {
	if err := a.resolveDirs(); err != nil {
		return nil, err
	}
	dataDir := opsDir
	if dataDir == "" {
		dataDir = a.dataDir
	}
	return scriptrunner.ListAvailableRegions(a.scriptDir, dataDir, appName)
}

// OpenURL opens rawURL in the operator's default browser — used for the
// deployed app's public URL. Only http(s) is accepted: this value comes from
// doctl output rather than being typed here, and handing an arbitrary scheme
// to the OS opener is how a "URL" turns into a launched program.
func (a *App) OpenURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("refusing to open non-http(s) URL: %s", rawURL)
	}
	return platform.OpenURL(rawURL)
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
	if err := a.resolveDirs(); err != nil {
		wailsEmitter{ctx: a.ctx}.EmitExit("create:exit", scriptrunner.ExitInfo{AppName: req.AppName, Code: -1, Err: err.Error()})
		return
	}
	req.ScriptDir = a.scriptDir
	if req.OpsDir == "" {
		req.OpsDir = a.dataDir
	}
	go func() {
		_ = scriptrunner.RunCreate(req, wailsEmitter{ctx: a.ctx})
	}()
}

// RunDelete starts delete.sh in the background and returns immediately;
// progress and the final result arrive as "delete:log" / "delete:exit"
// events (see scriptrunner.RunDelete).
func (a *App) RunDelete(req scriptrunner.DeleteRequest) {
	if err := a.resolveDirs(); err != nil {
		wailsEmitter{ctx: a.ctx}.EmitExit("delete:exit", scriptrunner.ExitInfo{AppName: req.AppName, Code: -1, Err: err.Error()})
		return
	}
	req.ScriptDir = a.scriptDir
	if req.OpsDir == "" {
		req.OpsDir = a.dataDir
	}
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

// --- self-update -----------------------------------------------------------
//
// See gerp93/KVG_Standards' packages/go/kvgupdate README. As with that
// package generally, the download-extract-replace-relaunch path here has
// not been exercised end-to-end against a real gameshell-deploy release —
// verify it against an actual tagged build before relying on it silently.

// UpdateInfo reports whether a newer release than the running build is
// available.
type UpdateInfo struct {
	Available bool   `json:"available"`
	Version   string `json:"version"`
}

// CheckForUpdate polls GitHub Releases for a newer gameshell-deploy-gui
// build than appVersion. Available is false (no error) when already up to
// date. release-go-gui.yml stamps appVersion via -ldflags when
// version_ldflag_package is passed (see auto-release.yml).
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info, err := kvgupdate.CheckForUpdate(updateRepo, updateAppName, appVersion)
	if err != nil || info == nil {
		return UpdateInfo{}, err
	}
	return UpdateInfo{Available: true, Version: info.Version}, nil
}

// ApplyUpdate prefers the Windows Inno Setup installer (whole app payload:
// exe + create.sh + delete.sh + templates), then the zip/tar fallback.
// Zip fallback copies package files into the install dir except a
// top-level games/ path, then replaces the exe. Does not return on success.
func (a *App) ApplyUpdate() error {
	applied, err := tryWindowsInstallerUpdate(updateRepo, updateAppName, appVersion)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	info, err := kvgupdate.CheckForUpdate(updateRepo, updateAppName, appVersion)
	if err != nil {
		return err
	}
	if info == nil {
		return fmt.Errorf("no update available")
	}
	stagedDir, err := kvgupdate.DownloadAndExtract(info, updateAppName)
	if err != nil {
		return err
	}
	if err := copyStagedPayloadSkippingGames(stagedDir, updateAppName); err != nil {
		return err
	}
	return kvgupdate.ApplyUpdateAndRestart(stagedDir, updateAppName) // does not return on success
}
