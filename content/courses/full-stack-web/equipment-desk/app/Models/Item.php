<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Item extends Model
{
    public $timestamps = false;

    protected function casts(): array
    {
        return ['available' => 'integer'];
    }
}
