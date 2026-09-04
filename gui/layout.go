package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// operatorDataDirName is the UserConfigDir folder for writable games/
// backups when this GUI is not running from a git checkout (installed
// Windows setup.exe, or an extracted Linux/macOS archive). Git checkouts
// keep games/ in the repo — do not move those into AppData.
const operatorDataDirName = "gameshell-deploy"

// removedGamesFile is a JSON list of game folder names the operator
// deleted or renamed away. seedMissingGames will not recreate these from
// the package seed — otherwise every restart would restore the catalog
// names whose folders are gone.
const removedGamesFile = "removed-games.json"

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
// folder does not already exist and the operator has not deleted or
// renamed it away. Existing folders (backups, deploy.conf, logs) are
// skipped entirely — never overwritten.
func seedMissingGames(scriptDir, dataDir string) error {
	destRoot := filepath.Join(dataDir, "games")
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return err
	}
	// A missing, truncated, or unreadable denylist must not fail
	// operatorDataDir — that path is GetOpsDir, which the sidebar and
	// Open data folder need. Treat any load error as "no names skipped".
	removed, err := loadRemovedGames(dataDir)
	if err != nil {
		removed = map[string]struct{}{}
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
			if _, skip := removed[e.Name()]; skip {
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

func removedGamesPath(dataDir string) string {
	return filepath.Join(dataDir, removedGamesFile)
}

func loadRemovedGames(dataDir string) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	data, err := os.ReadFile(removedGamesPath(dataDir))
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	if err := json.Unmarshal(data, &names); err != nil {
		// Truncated or corrupt JSON must not block resolving the data
		// dir — treat as an empty denylist. saveRemovedGames writes
		// atomically, but a crash mid-write can still leave junk.
		return out, nil
	}
	for _, name := range names {
		if name != "" {
			out[name] = struct{}{}
		}
	}
	return out, nil
}

func saveRemovedGames(dataDir string, names map[string]struct{}) error {
	list := make([]string, 0, len(names))
	for name := range names {
		list = append(list, name)
	}
	sort.Strings(list)
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomic(removedGamesPath(dataDir), data, 0o644)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "removed-games-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	// Rename already replaces an existing dest (including on Windows via
	// MoveFileEx REPLACE_EXISTING). Do not Remove the dest first: a
	// locked file can be marked pending-delete while the name stays
	// reserved, so a retry still fails and the denylist is gone.
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// rememberRemovedGame records that the operator deleted or renamed away
// this game folder, so a later seed pass will not recreate it. Git
// checkouts keep games/ in the repo and never seed, so this is a no-op
// there — the file must not land in a working tree.
func rememberRemovedGame(dataDir, name string) error {
	if name == "" || isGitCheckout(dataDir) {
		return nil
	}
	names, err := loadRemovedGames(dataDir)
	if err != nil {
		return err
	}
	if _, ok := names[name]; ok {
		return nil
	}
	names[name] = struct{}{}
	return saveRemovedGames(dataDir, names)
}

// forgetRemovedGame drops name from the denylist so a newly created or
// renamed-to folder can be treated as a live game again (and so a later
// DeleteGame re-records it cleanly).
func forgetRemovedGame(dataDir, name string) error {
	if name == "" || isGitCheckout(dataDir) {
		return nil
	}
	names, err := loadRemovedGames(dataDir)
	if err != nil {
		return err
	}
	if _, ok := names[name]; !ok {
		return nil
	}
	delete(names, name)
	if len(names) == 0 {
		err := os.Remove(removedGamesPath(dataDir))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return saveRemovedGames(dataDir, names)
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
