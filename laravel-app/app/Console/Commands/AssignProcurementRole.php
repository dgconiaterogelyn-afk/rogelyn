<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('procurement:assign-role {email} {role : requester, procurement, or admin}')]
#[Description('Assign a role to an existing Efcharisto Nexus user')]
class AssignProcurementRole extends Command
{
    public function handle(): int
    {
        $role = $this->argument('role');
        if (! in_array($role, ['requester', 'procurement', 'admin'], true)) {
            $this->error('Role must be requester, procurement, or admin.');

            return self::FAILURE;
        }

        $user = User::query()->where('email', $this->argument('email'))->first();
        if (! $user) {
            $this->error('No user exists with that email address.');

            return self::FAILURE;
        }

        $user->update(['role' => $role]);
        $this->info("Assigned the {$role} role to {$user->email}.");

        return self::SUCCESS;
    }
}
