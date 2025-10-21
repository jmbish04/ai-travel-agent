#!/bin/bash

# D1 Database Schema Inspector
# Usage: ./inspect-db.sh [--with-data]

set -e

DB_NAME="travel-agent-db"
SHOW_DATA=false

# Parse arguments
if [ "$1" = "--with-data" ]; then
    SHOW_DATA=true
fi

echo "🔍 D1 Database Schema Inspector"
echo "Database: $DB_NAME"
echo "========================================"
echo

# Get list of all tables
echo "📋 LISTING ALL TABLES:"
echo "----------------------"
TABLES=$(wrangler d1 execute $DB_NAME --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --json | jq -r '.[].results[].name' 2>/dev/null || echo "")

if [ -z "$TABLES" ]; then
    echo "❌ No tables found or database is empty"
    echo
    echo "💡 To create initial schema, run:"
    echo "   npm run db:migrate"
    echo "   or"
    echo "   npm run db:execute -- --file=./migrations/001_initial_schema.sql"
    exit 0
fi

echo "$TABLES"
echo

# For each table, show schema and optionally data
echo "📊 TABLE SCHEMAS AND DATA:"
echo "=========================="

for table in $TABLES; do
    echo
    echo "🗂️  TABLE: $table"
    echo "----------------------------------------"

    # Get table schema
    echo "📝 Schema:"
    wrangler d1 execute $DB_NAME --command="SELECT sql FROM sqlite_master WHERE type='table' AND name='$table';" --json 2>/dev/null | jq -r 'try (.[].results[].sql) catch "Error reading schema"' | sed 's/^/   /'

    # Get column info
    echo
    echo "🏗️  Columns:"
    wrangler d1 execute $DB_NAME --command="PRAGMA table_info($table);" --json 2>/dev/null | jq -r 'try (.[].results[] | "   \(.name) (\(.type)) - PK:\(.pk) - NotNull:\(.notnull) - Default:\(.dflt_value // "NULL")") catch "   Error reading column info"'

    # Show row count
    echo
    echo "📊 Row Count:"
    ROW_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM $table;" --json 2>/dev/null | jq -r 'try (.[].results[].count) catch "0"')
    echo "   $ROW_COUNT rows"

    # Show sample data if requested and rows exist
    if [ "$SHOW_DATA" = true ] && [ "$ROW_COUNT" -gt 0 ] 2>/dev/null; then
        echo
        echo "📄 Sample Data (up to 5 rows):"
        wrangler d1 execute $DB_NAME --command="SELECT * FROM $table LIMIT 5;" --json 2>/dev/null | jq -r 'try (.[].results[] | to_entries | map("\(.key): \(.value)") | "   " + join(", ")) catch "   Error reading sample data"'
    fi

    echo
    echo "----------------------------------------"
done

echo
echo "✅ Database inspection complete!"
echo

if [ "$SHOW_DATA" = false ]; then
    echo "💡 To see sample data from tables, run:"
    echo "   ./inspect-db.sh --with-data"
    echo "   or"
    echo "   npm run db:inspect -- --with-data"
fi

echo
echo "🛠️  Additional Commands:"
echo "   npm run db:inspect          - Run this script"
echo "   npm run db:inspect-data     - Run with sample data"
echo "   npm run db:list             - List applied migrations"
echo "   npm run db:migrate          - Apply pending migrations"
