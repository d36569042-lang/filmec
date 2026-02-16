# ============================================================================
# CINEMATE v2.0 - Быстрый запуск на Windows PowerShell
# ============================================================================

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           CINEMATE v2.0 - Инициализация системы                  ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Проверяем Node.js
Write-Host "[1/3] Проверка Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "✅ Node.js найден: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js не установлен!" -ForegroundColor Red
    Write-Host "📥 Скачайте с https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Проверяем npm
Write-Host "[2/3] Проверка npm..." -ForegroundColor Yellow
try {
    $npmVersion = npm --version
    Write-Host "✅ npm найден: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ npm не установлен!" -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Проверяем наличие package.json
Write-Host "[3/3] Проверка файлов проекта..." -ForegroundColor Yellow
if (-not (Test-Path "package.json")) {
    Write-Host "❌ package.json не найден!" -ForegroundColor Red
    Write-Host "📁 Убедитесь, что находитесь в директории проекта" -ForegroundColor Yellow
    Read-Host "Нажмите Enter для выхода"
    exit 1
}
Write-Host "✅ package.json найден" -ForegroundColor Green

# Устанавливаем зависимости если нужно
if (-not (Test-Path "node_modules")) {
    Write-Host ""
    Write-Host "📥 Установка зависимостей..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Ошибка при установке зависимостей!" -ForegroundColor Red
        Read-Host "Нажмите Enter для выхода"
        exit 1
    }
    Write-Host "✅ Зависимости установлены" -ForegroundColor Green
}

# Запускаем сервер
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    🎬 ЗАПУСК СЕРВЕРА                            ║" -ForegroundColor Green
Write-Host "║              Откройте браузер на http://localhost:3000          ║" -ForegroundColor Green
Write-Host "║         Нажмите Ctrl+C для остановки сервера                   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

npm start

Read-Host "Нажмите Enter для выхода"
