<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Middleware;
use Dhimantai\BuildStudio\StockObservation;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php')
    ->withMiddleware(function (Middleware $middleware) {
        $hook = '/opt/build-studio/StockObservation.php';
        if (is_file($hook)) {
            require_once $hook;
            $middleware->append(StockObservation::class);
        }
    })
    ->withExceptions()
    ->create();
