#!/bin/bash

# D1 Database Migration Helper Script
# Usage: ./migrate.sh [command] [options]

set -e

DB_NAME="travel-agent-db"
MIGRATIONS_DIR="./migrations"

case "$1" in
  "apply")
    echo "🔄 Applying migrations to $DB_NAME..."
    wrangler d1 migrations apply $DB_NAME
    echo "✅ Migrations applied successfully!"
    ;;
  "list")
    echo "📋 Listing migrations for $DB_NAME..."
    wrangler d1 migrations list $DB_NAME
    ;;
  "create")
    if [ -z "$2" ]; then
      echo "❌ Error: Migration name is required"
      echo "Usage: ./migrate.sh create <migration-name>"
      exit 1
    fi
    echo "📝 Creating new migration: $2"
    wrangler d1 migrations create $DB_NAME $2
    echo "✅ Migration file created in $MIGRATIONS_DIR/"
    ;;
  "execute")
    if [ -z "$2" ]; then
      echo "❌ Error: SQL file is required"
      echo "Usage: ./migrate.sh execute <sql-file>"
      exit 1
    fi
    echo "🚀 Executing SQL file: $2"
    wrangler d1 execute $DB_NAME --file=$2
    echo "✅ SQL executed successfully!"
    ;;
  "status")
    echo "📊 Migration status for $DB_NAME..."
    wrangler d1 migrations list $DB_NAME
    echo ""
    echo "📁 Available migration files:"
    ls -la $MIGRATIONS_DIR/
    ;;
  "help"|*)
    echo "🛠️  D1 Migration Helper"
    echo ""
    echo "Commands:"
    echo "  apply           Apply all pending migrations"
    echo "  list            List applied migrations"
    echo "  create <name>   Create a new migration file"
    echo "  execute <file>  Execute a SQL file directly"
    echo "  status          Show migration status and files"
    echo "  help            Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./migrate.sh apply"
    echo "  ./migrate.sh create add_user_preferences"
    echo "  ./migrate.sh execute ./schema.sql"
    ;;
esac
