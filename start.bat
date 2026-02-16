@echo off
REM ============================================================================
REM  CINEMATE v2.0 - Быстрый запуск на Windows
REM ============================================================================

echo.
echo ╔══════════════════════════════════════════════════════════════════╗
echo ║           CINEMATE v2.0 - Инициализация системы                  ║
echo ╚══════════════════════════════════════════════════════════════════╝
echo.

REM Проверяем Node.js
echo [1/3] Проверка Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не установлен!
    echo 📥 Скачайте с https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js найден

REM Проверяем npm
echo [2/3] Проверка npm...
npm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ npm не установлен!
    pause
    exit /b 1
)
echo ✅ npm найден

REM Проверяем наличие package.json
echo [3/3] Проверка файлов проекта...
if not exist "package.json" (
    echo ❌ package.json не найден!
    echo 📁 Убедитесь, что находитесь в директории проекта
    pause
    exit /b 1
)
echo ✅ package.json найден

REM Устанавливаем зависимости если нужно
if not exist "node_modules" (
    echo.
    echo 📥 Установка зависимостей...
    call npm install
    if errorlevel 1 (
        echo ❌ Ошибка при установке зависимостей!
        pause
        exit /b 1
    )
    echo ✅ Зависимости установлены
)

REM Запускаем сервер
echo.
echo ╔══════════════════════════════════════════════════════════════════╗
echo ║                    🎬 ЗАПУСК СЕРВЕРА                            ║
echo ║              Откройте браузер на http://localhost:3000          ║
echo ║         Нажмите Ctrl+C для остановки сервера                   ║
echo ╚══════════════════════════════════════════════════════════════════╝
echo.

npm start

pause
