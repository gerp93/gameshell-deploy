package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

// skipUpdateRel reports whether rel (from the staged package root) must not
// be copied into the install dir on zip fallback. Top-level games/ is
// operator data — the installer puts seed files under seed/games instead.
func skipUpdateRel(rel string) bool {
	rel = strings.ReplaceAll(rel, `\`, "/")
	rel = filepath.ToSlash(rel)
	rel = strings.TrimPrefix(rel, "./")
	if rel == "" || rel == "." {
		return false
	}
	first, _, _ := strings.Cut(rel, "/")
	return strings.EqualFold(first, "games")
}

func updatePackageRoot(stagedDir string) (string, error) {
	entries, err := os.ReadDir(stagedDir)
	if err != nil {
		return "", err
	}
	if len(entries) == 1 && entries[0].IsDir() {
		return filepath.Join(stagedDir, entries[0].Name()), nil
	}
	return stagedDir, nil
}

// copyStagedPayloadSkippingGames copies the zip/tar payload next to the
// running exe, except a top-level games/ tree and the exe itself (the
// kvgupdate Windows batch swap still replaces that). Mirrors KVG_Standards
// kvgupdate's zip fallback so an in-app update installs create.sh/templates
// without clobbering operator backups.
func copyStagedPayloadSkippingGames(stagedDir, appName string) error {
	root, err := updatePackageRoot(stagedDir)
	if err != nil {
		return err
	}
	currentExe, err := os.Executable()
	if err != nil {
		return err
	}
	currentExe, err = filepath.Abs(currentExe)
	if err != nil {
		return err
	}
	destDir := filepath.Dir(currentExe)
	skipBase := filepath.Base(currentExe)

	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if skipUpdateRel(rel) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if path == root {
			return nil
		}
		dest := filepath.Join(destDir, rel)
		if info.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		if skipBase != "" && filepath.Base(path) == skipBase {
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ".exe") && strings.EqualFold(filepath.Base(path), appName+".exe") {
			return nil
		}
		return copyFileReplace(path, dest)
	})
}

func copyFileReplace(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
