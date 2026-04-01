#!/bin/bash
BACKUP_DIR="/root/crown/backups"
mkdir -p "$BACKUP_DIR"

# Use sqlite3 .backup for a safe online backup
docker exec crown-crown-1 sqlite3 /app/data/crown.db ".backup '/app/data/crown-backup.db'"

# Copy out and timestamp it
docker cp crown-crown-1:/app/data/crown-backup.db "$BACKUP_DIR/crown-$(date +%Y%m%d).db"

# Clean up temp backup inside container
docker exec crown-crown-1 rm -f /app/data/crown-backup.db

# Keep only last 7 days
find "$BACKUP_DIR" -name "crown-*.db" -mtime +7 -delete

echo "Crown backup completed: $(date)"
