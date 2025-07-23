# Card Judge - Infrastructure

These scripts will allow for easy create/restore and backup/delete of card judge instances.

## Prerequisites

Have a [Digital Ocean](https://www.digitalocean.com/) account created.

Ensure you have your system's ssh key added to your Digital Ocean account.

Install [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) on your system.

Generate an API token with the following scope access:

- app (full)
- droplet (full)
- ssh_key (read)

Authenticate to your account using the generated token:

```bash
doctl auth init -t $TOKEN
```

## [create.sh](create.sh)

Create a new instance of card judge and restore the database backup.

## [delete.sh](delete.sh)

Backup the database and delete an existing instance of card judge.
