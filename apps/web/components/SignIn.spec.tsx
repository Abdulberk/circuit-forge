/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

import { ApiError } from '../lib/api';

import { SignIn } from './SignIn';

const client = { signIn: jest.fn(), register: jest.fn() };
const refreshSignedIn = jest.fn();
jest.mock('../app/providers', () => ({ useSession: () => ({ client, refreshSignedIn }) }));
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

beforeEach(() => {
    client.signIn.mockReset().mockResolvedValue(undefined);
    client.register.mockReset().mockResolvedValue(undefined);
    refreshSignedIn.mockReset();
});

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = async (name: string) => {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
    });
};

describe('sign in and sign up', () => {
    it('signs in with email and password, then hands control back', async () => {
        const done = jest.fn();
        render(<SignIn onSignedIn={done} />);
        fill('Email', 'ada@example.com');
        fill('Password', 'correct horse');
        await submit('Sign in');
        expect(client.signIn).toHaveBeenCalledWith('ada@example.com', 'correct horse', expect.any(AbortSignal));
        expect(refreshSignedIn).toHaveBeenCalled();
        expect(done).toHaveBeenCalled();
    });

    it('creates an account from the same screen, with a name', async () => {
        render(<SignIn />);
        fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
        expect(screen.getByRole('heading', { name: 'Create your account' })).toBeTruthy();
        fill('Name', 'Ada Lovelace');
        fill('Email', 'ada@example.com');
        fill('Password', 'correct horse');
        await submit('Create account');
        expect(client.register).toHaveBeenCalledWith(
            'Ada Lovelace',
            'ada@example.com',
            'correct horse',
            expect.any(AbortSignal),
        );
        expect(client.signIn).not.toHaveBeenCalled();
    });

    it('says plainly when the credentials are wrong, and when the account already exists', async () => {
        client.signIn.mockRejectedValue(new ApiError('unauthenticated', 'Invalid credentials', { status: 401 }));
        render(<SignIn />);
        fill('Email', 'ada@example.com');
        fill('Password', 'wrong');
        await submit('Sign in');
        expect(screen.getByRole('alert').textContent).toMatch(/do not match an account/);

        client.register.mockRejectedValue(new ApiError('conflict', 'Email taken', { status: 409 }));
        fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
        fill('Name', 'Ada');
        fill('Password', 'correct horse');
        await submit('Create account');
        expect(screen.getByRole('alert').textContent).toMatch(/already exists/);
    });
});
