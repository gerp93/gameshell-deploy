package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// operatorDataDirName is the UserConfigDir folder for writable games/
// backups when this GUI is not running from a git checkout (installed
// Windows setup.exe, or an extracted Linux/macOS archive). Git checkouts
// keep games/ in the repo — do not move those into AppData.
const operatorDataDirName = "gameshell-deploy"

func findScriptDir() (string, error) {
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
	return "", fmt.Errorf("could not find create.sh, delete.sh, templates/, deploy.conf.template above %s", filepath.Dir(exe))
}

func isGitCheckout(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

func operatorDataDir(scriptDir string) (string, error) {
	if isGitCheckout(scriptDir) {
		return scriptDir, nil
	}
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cfg, operatorDataDirName)
	if err := os.MkdirAll(filepath.Join(dir, "games"), 0o755); err != nil {
		return "", err
	}
	if err := seedMissingGames(scriptDir, dir); err != nil {
		return "", err
	}
	return dir, nil
}

// seedMissingGames copies each game folder from scriptDir/seed/games or
// scriptDir/games into dataDir/games only when that game's destination
// folder does not already exist. Existing folders (backups, deploy.conf,
// logs) are skipped entirely — never overwritten.
func seedMissingGames(scriptDir, dataDir string) error {
	destRoot := filepath.Join(dataDir, "games")
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return err
	}
	var sources []string
	for _, rel := range []string{filepath.Join("seed", "games"), "games"} {
		src := filepath.Join(scriptDir, rel)
		if info, err := os.Stat(src); err == nil && info.IsDir() {
			sources = append(sources, src)
		}
	}
	for _, src := range sources {
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			dest := filepath.Join(destRoot, e.Name())
			if _, err := os.Stat(dest); err == nil {
				continue
			}
			if err := copyDirNoClobber(filepath.Join(src, e.Name()), dest); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyDirNoClobber(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if _, err := os.Stat(target); err == nil {
			return nil
		}
		return copyFileExclusive(path, target)
	})
}

func copyFileExclusive(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}
