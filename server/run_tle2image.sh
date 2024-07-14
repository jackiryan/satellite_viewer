#!/bin/sh

# Navigate to the server directory
cd /server

# Run the download, update, and validate commands
make download
make update
make validate

# Keep the container running
exec "$@"