import { redirect } from 'next/navigation';

/** The app starts at the projects list; signed-out users are sent on to /login from there. */
export default function Home() {
    redirect('/projects');
}
