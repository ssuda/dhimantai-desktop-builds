<?php

namespace App\Http\Controllers;

use App\Models\Item;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class LoanController
{
    public function store(Request $request, Item $item): JsonResponse
    {
        $fields = $request->validate([
            'borrower' => ['required', 'string', 'max:60'],
            'quantity' => ['required', 'integer', 'min:1', 'max:20'],
        ]);

        // Decide whether the desk can record this checkout.
        $id = DB::table('loans')->insertGetId([
            'item_id' => $item->id,
            'borrower' => $fields['borrower'],
            'quantity' => $fields['quantity'],
        ]);
        $item->decrement('available', $fields['quantity']);
        return response()->json(['id' => $id, 'available' => $item->refresh()->available], 201);
    }
}
