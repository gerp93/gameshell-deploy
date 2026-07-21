// Package preflight checks that the tools create.sh/delete.sh depend on
// (doctl, gpg, ssh/scp, and on Windows, WSL itself) are present before the
// GUI lets an operator start a run.
package preflight

import "gameshell-deploy-gui/platform"

// CheckResult is one prerequisite's pass/fail state plus a short
// remediation hint shown when it fails.
type CheckResult struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Result is the full set of prerequisite checks. WSLBlocking is true only
// on Windows when wsl.exe itself isn't installed/responsive — in that case
// nothing else can be checked, and the GUI should show a blocking
// "Install WSL" panel instead of the rest of the checks.
type Result struct {
	WSLBlocking bool          `json:"wslBlocking"`
	Checks      []CheckResult `json:"checks"`
}

// RunChecks runs every prerequisite check and returns their results.
func RunChecks() Result {
	if platform.IsWindows() && !platform.WSLAvailable() {
		return Result{
			WSLBlocking: true,
			Checks: []CheckResult{
				{Name: "WSL", OK: false, Detail: "WSL is not installed or not responding. Install it with `wsl --install` in an admin PowerShell, then restart this app."},
			},
		}
	}

	checks := []CheckResult{
		checkDoctlInstalled(),
		checkDoctlAuthenticated(),
		checkTool("gpg", "GPG", "Install gpg (e.g. `sudo apt install gnupg` inside WSL, or `brew install gnupg` on macOS) — it encrypts/decrypts database backups."),
		checkTool("ssh", "SSH", "Install an OpenSSH client (e.g. `sudo apt install openssh-client` inside WSL) — it's used to reach the database droplet."),
		checkTool("scp", "SCP", "SCP normally ships with the OpenSSH client — install openssh-client if it's missing."),
	}

	if platform.IsWindows() {
		checks = append([]CheckResult{
			{Name: "WSL", OK: true, Detail: "WSL is installed and responding."},
		}, checks...)
	}

	return Result{WSLBlocking: false, Checks: checks}
}

func checkTool(bin, name, hint string) CheckResult {
	if platform.LookPath(bin) {
		return CheckResult{Name: name, OK: true, Detail: name + " found."}
	}
	return CheckResult{Name: name, OK: false, Detail: hint}
}

func checkDoctlInstalled() CheckResult {
	return checkTool("doctl", "doctl", "Install doctl (https://docs.digitalocean.com/reference/doctl/how-to/install/) — it drives every Digital Ocean API call these scripts make.")
}

func checkDoctlAuthenticated() CheckResult {
	if !platform.LookPath("doctl") {
		return CheckResult{Name: "doctl auth", OK: false, Detail: "doctl isn't installed yet."}
	}
	cmd, err := platform.RawCommand("doctl", []string{"account", "get"})
	if err != nil {
		return CheckResult{Name: "doctl auth", OK: false, Detail: err.Error()}
	}
	if err := cmd.Run(); err != nil {
		return CheckResult{Name: "doctl auth", OK: false, Detail: "doctl is not authenticated — run `doctl auth init -t $TOKEN`."}
	}
	return CheckResult{Name: "doctl auth", OK: true, Detail: "doctl is authenticated."}
}
