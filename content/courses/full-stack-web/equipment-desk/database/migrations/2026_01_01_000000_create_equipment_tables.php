<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('items', function (Blueprint $table) {
            $table->id();
            $table->string('name')->unique();
            $table->unsignedInteger('available');
        });
        Schema::create('loans', function (Blueprint $table) {
            $table->id();
            $table->foreignId('item_id')->constrained();
            $table->string('borrower', 60);
            $table->unsignedInteger('quantity');
            $table->timestamp('created_at')->useCurrent();
        });
        DB::table('items')->insert([
            ['name' => 'Camera', 'available' => 3],
            ['name' => 'Tripod', 'available' => 5],
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('loans');
        Schema::dropIfExists('items');
    }
};
