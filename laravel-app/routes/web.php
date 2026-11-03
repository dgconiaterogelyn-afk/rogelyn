<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\ProcurementController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::prefix('api')->group(function () {
    Route::get('/csrf-token', [AuthController::class, 'csrfToken']);
    Route::post('/auth/register', [AuthController::class, 'register'])->middleware('throttle:5,1');
    Route::post('/auth/login', [AuthController::class, 'login'])->middleware('throttle:5,1');
    Route::get('/auth/me', [AuthController::class, 'user']);
    Route::post('/auth/logout', [AuthController::class, 'logout'])->middleware('auth');

    Route::middleware('auth')->group(function () {
        Route::get('/procurement', [ProcurementController::class, 'index']);
        Route::post('/requests', [ProcurementController::class, 'storeRequest']);
        Route::post('/requests/{purchaseRequest}/review', [ProcurementController::class, 'reviewRequest']);
        Route::post('/requests/{purchaseRequest}/purchase-order', [ProcurementController::class, 'createPurchaseOrder']);
        Route::patch('/purchase-orders/{purchaseOrder}/receiving', [ProcurementController::class, 'receivePurchaseOrder']);
        Route::post('/suppliers', [ProcurementController::class, 'storeSupplier']);
        Route::put('/suppliers/{supplier}', [ProcurementController::class, 'updateSupplier']);
    });
});
