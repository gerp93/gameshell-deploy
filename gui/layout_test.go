package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSeedMissingGamesSkipsExistingFolder(t *testing.T) {
	scriptDir := t.TempDir()
	dataDir := t.TempDir()

	mustWrite(t, filepath.Join(scriptDir, "seed", "games", "card-judge", "deploy.conf"), "SEED")
	mustWrite(t, filepath.Join(scriptDir, "games", "track-timeline", "deploy.conf"), "REPO")

	// Existing operator data — backups must survive a seed pass.
	existing := filepath.Join(dataDir, "games", "card-judge")
	mustWrite(t, filepath.Join(existing, "deploy.conf"), "OPERATOR")
	mustWrite(t, filepath.Join(existing, "backups", "keep.gpg"), "BACKUP")

	if err := seedMissingGames(scriptDir, dataDir); err != nil {
		t.Fatal(err)
	}

	gotConf, err := os.ReadFile(filepath.Join(existing, "deploy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotConf) != "OPERATOR" {
		t.Fatalf("existing deploy.conf overwritten: %q", gotConf)
	}
	gotBackup, err := os.ReadFile(filepath.Join(existing, "backups", "keep.gpg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotBackup) != "BACKUP" {
		t.Fatalf("existing backup overwritten: %q", gotBackup)
	}

	gotNew, err := os.ReadFile(filepath.Join(dataDir, "games", "track-timeline", "deploy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotNew) != "REPO" {
		t.Fatalf("missing game not seeded: %q", gotNew)
	}
}

func TestSeedMissingGamesPrefersSeedDir(t *testing.T) {
	scriptDir := t.TempDir()
	dataDir := t.TempDir()
	mustWrite(t, filepath.Join(scriptDir, "seed", "games", "card-judge", "deploy.conf"), "FROM_SEED")
	mustWrite(t, filepath.Join(scriptDir, "games", "card-judge", "deploy.conf"), "FROM_GAMES")

	if err := seedMissingGames(scriptDir, dataDir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dataDir, "games", "card-judge", "deploy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "FROM_SEED" {
		t.Fatalf("expected seed/games to win when dest is empty, got %q", got)
	}
}

func TestOperatorDataDirKeepsGitCheckout(t *testing.T) {
	scriptDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(scriptDir, ".git"), []byte("gitdir: /somewhere"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := operatorDataDir(scriptDir)
	if err != nil {
		t.Fatal(err)
	}
	if got != scriptDir {
		t.Fatalf("git checkout data dir = %q, want script dir", got)
	}
}

func TestSeedMissingGamesSkipsRemovedGames(t *testing.T) {
	scriptDir := t.TempDir()
	dataDir := t.TempDir()
	mustWrite(t, filepath.Join(scriptDir, "seed", "games", "card-judge", "deploy.conf"), "SEED")
	mustWrite(t, filepath.Join(scriptDir, "seed", "games", "track-timeline", "deploy.conf"), "KEEP")

	if err := rememberRemovedGame(dataDir, "card-judge"); err != nil {
		t.Fatal(err)
	}
	if err := seedMissingGames(scriptDir, dataDir); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "games", "card-judge")); !os.IsNotExist(err) {
		t.Fatalf("deleted seed game was recreated: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dataDir, "games", "track-timeline", "deploy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "KEEP" {
		t.Fatalf("unrelated game not seeded: %q", got)
	}
}

func TestForgetRemovedGameAllowsReseed(t *testing.T) {
	scriptDir := t.TempDir()
	dataDir := t.TempDir()
	mustWrite(t, filepath.Join(scriptDir, "seed", "games", "card-judge", "deploy.conf"), "SEED")

	if err := rememberRemovedGame(dataDir, "card-judge"); err != nil {
		t.Fatal(err)
	}
	if err := forgetRemovedGame(dataDir, "card-judge"); err != nil {
		t.Fatal(err)
	}
	if err := seedMissingGames(scriptDir, dataDir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dataDir, "games", "card-judge", "deploy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "SEED" {
		t.Fatalf("forgot name was not reseeded: %q", got)
	}
}

func TestRememberRemovedGameSkipsGitCheckout(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /somewhere"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rememberRemovedGame(dir, "card-judge"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, removedGamesFile)); !os.IsNotExist(err) {
		t.Fatalf("wrote %s into a git checkout: %v", removedGamesFile, err)
	}
}

func TestSkipUpdateRel(t *testing.T) {
	if !skipUpdateRel("games/card-judge/backups/x.gpg") {
		t.Fatal("expected to skip games/")
	}
	if skipUpdateRel("seed/games/card-judge/deploy.conf") {
		t.Fatal("seed/games is package payload, should copy")
	}
	if skipUpdateRel("create.sh") {
		t.Fatal("create.sh should copy")
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
