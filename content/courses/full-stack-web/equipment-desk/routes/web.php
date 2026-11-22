<?php

use App\Http\Controllers\LoanController;
use App\Models\Item;
use Illuminate\Support\Facades\Route;

Route::view('/', 'desk');
Route::get('/items', fn () => Item::orderBy('name')->get(['id', 'name', 'available']));
Route::post('/items/{item}/loans', [LoanController::class, 'store']);
